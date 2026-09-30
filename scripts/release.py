#!/usr/bin/env python3
"""Build once, publish an existing trusted CI artifact, deploy by SSH alias."""
from __future__ import annotations

import argparse
import base64
import datetime
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

from release_runner import (MAX_BYTES, MAX_FILES, PACKAGE_FIELDS, RUNTIME_PROBE, WORKSPACE,
                            canonical, command, digest, read_json, require, validate_archive,
                            validate_manifest)

REPOSITORY = "awoaCrim/YesImBot-Beta"
ASSETS = {"payload.tar.gz", "manifest.json", "runner.py"}
# The bootstrap is fixed local code, not fetched code. Only these control files
# may be written before the uploaded receiver acquires its long-lived flock.
BOOTSTRAP = r"""
import hashlib, json, os, pathlib, socket, stat, sys, tarfile
p = json.loads(sys.argv[1]); run = pathlib.Path(sys.argv[2]); expected = json.loads(sys.argv[3])
def check(condition, message):
    if not condition: raise RuntimeError(message)
check(os.geteuid() == 0 and socket.gethostname() == p['hostname'], 'host/user mismatch')
state = pathlib.Path(p['stateRoot'])
check(state.is_absolute() and state.resolve() == state and run.parent == state/'runs', 'unsafe state path')
for business in [pathlib.Path(p['sourceRoot']), pathlib.Path(p['dataRoot'])]:
    check(business.is_absolute() and business.resolve() == business, 'unsafe business root')
    check(not state.is_relative_to(business) and not business.is_relative_to(state), 'state overlaps business root')
check(set(expected) == {'manifest.json','runner.py','profile.json'} and sum(v['size'] for v in expected.values()) < 5*1024*1024, 'invalid controls')
for root in [state, state/'runs']:
    root.mkdir(mode=0o700, exist_ok=True)
    check(root.resolve() == root and root.stat().st_uid == 0 and stat.S_IMODE(root.stat().st_mode) == 0o700, 'unsafe state permissions')
os.umask(0o077); run.mkdir(mode=0o700)
seen = set()
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
    for m in archive:
        check(m.isfile() and m.name in expected and m.name not in seen and m.size == expected[m.name]['size'], 'invalid control member')
        seen.add(m.name); data = archive.extractfile(m).read()
        check(hashlib.sha256(data).hexdigest() == expected[m.name]['sha256'], 'control hash mismatch')
        (run/m.name).write_bytes(data)
check(seen == set(expected), 'missing controls')
print(json.dumps({'status':'controls_ready'}))
"""


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(urllib.parse.urlparse(newurl).scheme == "https", "insecure download redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, repository):
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "invalid repository")
        self.repository = repository
        self.base = "https://api.github.com/repos/" + repository
        self.token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        self.opener = urllib.request.build_opener(SafeRedirect())

    def credentials(self):
        if not self.token:
            result = subprocess.run(["git", "credential", "fill"], input=b"protocol=https\nhost=github.com\n\n", capture_output=True,
                                    env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}, timeout=30)
            if result.returncode == 0:
                values = dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)
                self.token = values.get("password")
        require(self.token, "GitHub credentials unavailable; use GH_TOKEN or Git Credential Manager")

    def request(self, path, method="GET", value=None, authenticated=True, binary=False):
        url = path if path.startswith("https://") else self.base + path
        host = urllib.parse.urlparse(url).hostname
        require(host in {"api.github.com", "uploads.github.com"}, "unexpected GitHub API host")
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "yesimbot-release"}
        if authenticated:
            self.credentials()
            headers["Authorization"] = "Bearer " + self.token
        data = None
        if value is not None:
            data = value if isinstance(value, bytes) else canonical(value)
            headers["Content-Type"] = "application/octet-stream" if isinstance(value, bytes) else "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        with self.opener.open(request, timeout=120) as response:
            result = response.read(MAX_BYTES + 1)
            require(len(result) <= MAX_BYTES, "API/download size budget exceeded")
        return result if binary else json.loads(result)

    def download(self, url, limit):
        parsed = urllib.parse.urlparse(url)
        require(parsed.scheme == "https" and parsed.hostname == "github.com" and parsed.path.startswith("/" + self.repository + "/releases/download/"), "invalid release asset URL")
        with self.opener.open(urllib.request.Request(url, headers={"User-Agent": "yesimbot-release"}), timeout=120) as response:
            data = response.read(limit + 1)
        require(len(data) <= limit, "asset size budget exceeded")
        return data


def workspace_metadata(root):
    p = read_json(root / "package.json")
    result = []
    paths = sorted({d for pattern in p["workspaces"] for d in root.glob(pattern) if (d / "package.json").is_file()})
    for d in paths:
        rel = d.relative_to(root).as_posix()
        require(WORKSPACE.fullmatch(rel) and d.resolve() == d, "unsupported workspace path")
        package = read_json(d / "package.json")
        outputs = [x for x in package.get("files", []) if x in {"dist", "lib"}]
        require(outputs and package.get("main"), "workspace lacks build output/main: " + rel)
        result.append({"path": rel, "package": {k: package[k] for k in PACKAGE_FIELDS if k in package},
                       "outputs": outputs, "role": "library" if rel.startswith("packages/") else "plugin"})
    require(result, "no build workspaces")
    return result


def runtime_fingerprint(root, workspaces):
    return json.loads(command(["node", "-e", RUNTIME_PROBE, canonical({"root": str(root), "workspaces": [w["path"] for w in workspaces]}).decode()], 180))


def add_tar_bytes(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = len(data), 0o644, 0
    archive.addfile(info, io.BytesIO(data))


def pack(root, output, repository, source_sha, run_id):
    root, output = Path(root).resolve(), Path(output).resolve()
    require(not output.exists(), "bundle output already exists; refusing overwrite")
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha) and str(run_id).isdigit(), "invalid source/run")
    require(command(["git", "-C", str(root), "rev-parse", "HEAD"]).strip() == source_sha, "checkout/source SHA mismatch")
    require(not command(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"]).strip(), "tracked checkout is dirty")
    workspaces = workspace_metadata(root)
    files = []
    for w in workspaces:
        for name in w["outputs"]:
            directory = root / w["path"] / name
            require(directory.is_dir() and not directory.is_symlink(), "missing build output: " + str(directory))
            for path in sorted(directory.rglob("*")):
                require(not path.is_symlink() and (path.is_file() or path.is_dir()), "linked/unsafe build output")
                if path.is_file():
                    files.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size, "sha256": digest(path)})
    require(len(files) <= MAX_FILES and sum(f["size"] for f in files) <= MAX_BYTES, "build output budget exceeded")
    runtime = runtime_fingerprint(root, workspaces)
    output.mkdir(parents=True)
    try:
        with (output / "payload.tar.gz").open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz, tarfile.open(fileobj=gz, mode="w|") as archive:
            for f in files:
                add_tar_bytes(archive, f["path"], (root / f["path"]).read_bytes())
        shutil.copyfile(Path(__file__).with_name("release_runner.py"), output / "runner.py")
        manifest = {"schema": 1, "repository": repository, "sourceSha": source_sha, "runId": str(run_id),
                    "workflow": ".github/workflows/ci.yml", "branch": "dev", "event": "push", "yarn": "4.12.0",
                    "lockSha256": digest(root / "yarn.lock"), "workspaces": workspaces, "files": files, "runtime": runtime}
        for key, name in (("payload", "payload.tar.gz"), ("runner", "runner.py")):
            manifest[key] = {"size": (output / name).stat().st_size, "sha256": digest(output / name)}
        validate_manifest(manifest)
        (output / "manifest.json").write_bytes(canonical(manifest) + b"\n")
        verify(output, repository=repository, source_sha=source_sha)
    except BaseException:
        # Owned fresh output only; never remove caller-owned source/old releases.
        shutil.rmtree(output)
        raise
    return {"status": "packed", "sourceSha": source_sha, "files": len(files), "payloadBytes": manifest["payload"]["size"]}


def verify(bundle, repository=None, source_sha=None, run_id=None):
    bundle = Path(bundle)
    require({p.name for p in bundle.iterdir()} == ASSETS, "unexpected bundle assets")
    require(all(p.is_file() and not p.is_symlink() for p in bundle.iterdir()), "linked bundle asset")
    require((bundle / "manifest.json").stat().st_size < 5 * 1024 * 1024, "manifest too large")
    m = validate_manifest(read_json(bundle / "manifest.json"))
    for actual, expected, label in ((m["repository"], repository, "repository"), (m["sourceSha"], source_sha, "source SHA"), (str(m["runId"]), str(run_id) if run_id is not None else None, "run ID")):
        require(expected is None or actual == expected, "bundle " + label + " mismatch")
    for key, name in (("payload", "payload.tar.gz"), ("runner", "runner.py")):
        p = bundle / name
        require(p.stat().st_size == m[key]["size"] and digest(p) == m[key]["sha256"], "bundle hash/size mismatch")
    with tarfile.open(bundle / "payload.tar.gz", "r:gz") as archive:
        validate_archive(archive, m["files"])
    return m


def trusted_run(run, workflow, repository):
    require(run.get("repository", {}).get("full_name") == repository and run.get("head_repository", {}).get("full_name") == repository,
            "run belongs to a different repository")
    require(run.get("event") == "push" and run.get("head_branch") == "dev" and run.get("status") == "completed" and run.get("conclusion") == "success",
            "only successful push-to-dev CI can be released")
    require(workflow.get("path") == ".github/workflows/ci.yml" and run.get("workflow_id") == workflow.get("id"), "run is not trusted ci.yml")
    require(re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")), "invalid run source SHA")
    return run["head_sha"]


def unpack_artifact(data, destination):
    destination = Path(destination)
    require(not destination.exists(), "artifact destination exists")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) == 3 and {e.filename for e in entries} == ASSETS and
                sum(e.file_size for e in entries) <= MAX_BYTES and
                all(not e.is_dir() and not (e.external_attr >> 16) & 0o170000 == 0o120000 for e in entries), "invalid artifact ZIP")
        destination.mkdir(parents=True)
        for e in entries:
            (destination / e.filename).write_bytes(archive.read(e))


def publish(repository, run_id, output):
    require(str(run_id).isdigit(), "run ID must contain digits only")
    github = GitHub(repository)
    run = github.request("/actions/runs/" + str(run_id))
    workflow = github.request("/actions/workflows/ci.yml")
    source = trusted_run(run, workflow, repository)
    values = github.request("/actions/runs/" + str(run_id) + "/artifacts?per_page=100")
    artifacts = [a for a in values["artifacts"] if a["name"] == "release-" + source and not a["expired"]]
    require(len(artifacts) == 1, "missing/ambiguous trusted release artifact")
    data = github.request("/actions/artifacts/" + str(artifacts[0]["id"]) + "/zip", binary=True)
    if artifacts[0].get("digest"):
        require(artifacts[0]["digest"] == "sha256:" + hashlib.sha256(data).hexdigest(), "CI artifact digest mismatch")
    unpack_artifact(data, output)
    verify(output, repository, source, run_id)
    # A second API read prevents publishing a run invalidated during retrieval.
    trusted_run(github.request("/actions/runs/" + str(run_id)), workflow, repository)
    day = run["created_at"][:10].replace("-", "")
    tag = "beta-" + day + "-" + source[:12]
    try:
        github.request("/git/ref/tags/" + tag)
    except urllib.error.HTTPError as error:
        require(error.code == 404, "cannot establish release tag state")
    else:
        raise RuntimeError("release tag already exists; refusing overwrite")
    # Creating the ref is an atomic uniqueness gate, including concurrent local
    # publishers. Failed publication may retain this ref and a draft to inspect.
    github.request("/git/refs", "POST", {"ref": "refs/tags/" + tag, "sha": source})
    release = github.request("/releases", "POST", {"tag_name": tag, "target_commitish": source, "name": tag, "draft": True, "prerelease": True,
                                                     "body": "Source: `" + source + "`\nCI: " + run["html_url"] + "\nBuild once; all assets are unchanged CI outputs."})
    upload = "https://uploads.github.com/repos/" + repository + "/releases/" + str(release["id"]) + "/assets?name="
    for name in sorted(ASSETS):
        asset = github.request(upload + urllib.parse.quote(name), "POST", (Path(output) / name).read_bytes())
        require(asset["size"] == (Path(output) / name).stat().st_size and asset["name"] == name, "release asset upload mismatch")
    github.request("/releases/" + str(release["id"]), "PATCH", {"draft": False})
    return {"status": "published", "tag": tag, "sourceSha": source, "runId": str(run_id), "url": release["html_url"]}


def download(repository, tag, destination):
    require(re.fullmatch(r"beta-\d{8}-[0-9a-f]{12}", tag), "invalid Beta release tag")
    github = GitHub(repository)
    release = github.request("/releases/tags/" + tag, authenticated=False)
    require(not release["draft"] and release["prerelease"] and {a["name"] for a in release["assets"]} == ASSETS and len(release["assets"]) == 3, "invalid release assets")
    destination = Path(destination)
    ref = github.request("/git/ref/tags/" + tag, authenticated=False)
    require(ref["object"]["type"] == "commit" and tag.endswith(ref["object"]["sha"][:12]), "release tag target mismatch")
    if destination.exists():
        m = verify(destination, repository, ref["object"]["sha"])
        for asset in release["assets"]:
            file = destination / asset["name"]
            require(file.stat().st_size == asset["size"] and
                    (not asset.get("digest") or asset["digest"] == "sha256:" + digest(file)), "cached asset differs from Release")
        return m
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".partial")
    temporary.mkdir()
    try:
        for asset in release["assets"]:
            require(0 < asset["size"] <= MAX_BYTES, "invalid asset size")
            data = github.download(asset["browser_download_url"], asset["size"])
            require(len(data) == asset["size"], "release download size mismatch")
            if asset.get("digest"):
                require(asset["digest"] == "sha256:" + hashlib.sha256(data).hexdigest(), "GitHub asset digest mismatch")
            (temporary / asset["name"]).write_bytes(data)
        m = verify(temporary, repository, ref["object"]["sha"])
        require(not destination.exists(), "another download filled the cache; retry")
        temporary.rename(destination)
        return m
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def ssh_call(alias, args, data=None):
    require(re.fullmatch(r"[A-Za-z0-9_.-]+", alias) and not alias.startswith("-"), "invalid SSH alias")
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", alias, shlex.join(args)],
                            input=data, capture_output=True, timeout=900)
    if result.returncode:
        # Receiver prints structured errors, not raw logs. Do not echo arbitrary
        # remote banner/output or credentials if the SSH transport itself fails.
        try:
            value = json.loads(result.stderr)
            raise RuntimeError(value.get("error", "remote release failed"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RuntimeError("SSH release command failed / " + str(result.returncode)) from None
    return json.loads(result.stdout)


def controls(bundle, profile, alias):
    run = Path(profile["stateRoot"]) / "runs" / uuid.uuid4().hex
    files = {name: (Path(bundle) / name).read_bytes() for name in ("manifest.json", "runner.py")}
    files["profile.json"] = canonical(profile)
    require(sum(len(v) for v in files.values()) < 5 * 1024 * 1024, "controls budget exceeded")
    expected = {name: {"size": len(value), "sha256": hashlib.sha256(value).hexdigest()} for name, value in files.items()}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for name, value in files.items():
            add_tar_bytes(archive, name, value)
    ssh_call(alias, ["python3", "-c", BOOTSTRAP, canonical(profile).decode(), run.as_posix(), canonical(expected).decode()], stream.getvalue())
    return run.as_posix()


def delta_archive(bundle, entries):
    expected = {f["path"] for f in entries}
    stream = io.BytesIO()
    with tarfile.open(Path(bundle) / "payload.tar.gz", "r:gz") as source, tarfile.open(fileobj=stream, mode="w:gz") as delta:
        for m in source:
            if m.name in expected:
                add_tar_bytes(delta, m.name, source.extractfile(m).read())
    return stream.getvalue()


def target_action(action, repository, tag, alias, profile_path, dry_run=False):
    profile = read_json(profile_path)
    bundle = Path(".release-cache") / tag
    if action in {"status", "recover", "rollback"} and bundle.exists():
        # Recovery must not depend on GitHub availability after activation. The
        # already-verified local control cache is sufficient to reach the ledger.
        m = verify(bundle, repository)
        require(re.fullmatch(r"beta-\d{8}-[0-9a-f]{12}", tag) and tag.endswith(m["sourceSha"][:12]), "cached recovery tag mismatch")
    else:
        download(repository, tag, bundle)
    run = controls(bundle, profile, alias)
    args = ["python3", run + "/runner.py", "--run-dir", run]
    if action != "deploy":
        return ssh_call(alias, args + [action])
    preview = ssh_call(alias, args + ["inventory"])
    if dry_run:
        return preview
    payload = delta_archive(bundle, preview["plan"]["write"]) if preview["plan"]["write"] or preview["plan"]["delete"] else b""
    return ssh_call(alias, args + ["deploy", "--inventory-sha", preview["inventorySha256"]], payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("pack")
    p.add_argument("--root", default=".")
    p.add_argument("--output", default=".release/bundle")
    p.add_argument("--source-sha", required=True)
    p.add_argument("--run-id", required=True)
    p = sub.add_parser("verify")
    p.add_argument("bundle")
    p.add_argument("--source-sha")
    p.add_argument("--run-id")
    p = sub.add_parser("publish")
    p.add_argument("--run-id", required=True)
    p.add_argument("--output", default=".release/published")
    for name in ("deploy", "status", "recover", "rollback", "verify-target"):
        p = sub.add_parser(name)
        p.add_argument("tag")
        p.add_argument("--target", default="ssh1")
        p.add_argument("--profile", default=".release-local/ssh1.json")
        if name == "deploy":
            p.add_argument("--dry-run", action="store_true")
    for p in sub.choices.values():
        p.add_argument("--repository", default=REPOSITORY)
    a = parser.parse_args()
    if a.action == "pack":
        value = pack(a.root, a.output, a.repository, a.source_sha, a.run_id)
    elif a.action == "verify":
        m = verify(a.bundle, a.repository, a.source_sha, a.run_id)
        value = {"status": "bundle_verified", "sourceSha": m["sourceSha"], "files": len(m["files"])}
    elif a.action == "publish":
        value = publish(a.repository, a.run_id, a.output)
    else:
        value = target_action("verify" if a.action == "verify-target" else a.action, a.repository, a.tag, a.target, a.profile, getattr(a, "dry_run", False))
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # HTTP error body may contain sensitive metadata. Never print response
        # bodies or headers, and never expose credential helper output.
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
