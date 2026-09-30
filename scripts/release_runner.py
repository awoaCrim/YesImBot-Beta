#!/usr/bin/env python3
"""Release contract and the single remote application writer (Python >= 3.11).

This file is shipped unchanged as runner.py. The local CLI imports its contract;
remote execution never imports project code or reads chat/config contents aloud.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import uuid

SCHEMA = 1
MAX_FILES = 10000
MAX_BYTES = 512 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{64}")
WORKSPACE = re.compile(r"(?:core|(?:packages|plugins|providers|platforms)/[a-zA-Z0-9_-]+)")
PACKAGE_FIELDS = ("name", "version", "type", "main", "exports", "dependencies",
                  "peerDependencies", "peerDependenciesMeta", "optionalDependencies")
HANDLED_SIGNALS = tuple(getattr(signal, name) for name in ("SIGHUP", "SIGTERM", "SIGINT") if hasattr(signal, name))
# Resolve package metadata without relying on the package.json export. Includes
# the installed runtime/peer graph, not devDependencies or absolute machine paths.
RUNTIME_PROBE = r"""
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const input = JSON.parse(process.argv[1]), root = input.root;
const fields = ['name','version','type','main','exports','dependencies','peerDependencies','peerDependenciesMeta','optionalDependencies'];
function metadata(p) { return Object.fromEntries(fields.filter(k => k in p).map(k => [k,p[k]])); }
function locate(req, name) {
  try { return req.resolve(name + '/package.json'); } catch {}
  for (const base of req.resolve.paths(name) || []) {
    const candidate = path.join(base, name, 'package.json');
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate)).name === name) return fs.realpathSync(candidate);
  }
  throw new Error('runtime dependency unresolved: ' + name);
}
const raw = new Map(), rootFiles = {}, packages = {};
function visit(file) {
  file = fs.realpathSync(file);
  if (raw.has(file)) return file;
  const p = JSON.parse(fs.readFileSync(file)), identity = p.name + '@' + p.version;
  const node = { identity, edges: {} }; raw.set(file, node);
  const req = createRequire(file);
  for (const name of [...new Set([...Object.keys(p.dependencies || {}), ...Object.keys(p.peerDependencies || {}), ...Object.keys(p.optionalDependencies || {})])].sort()) {
    let candidate;
    try { candidate = locate(req, name); }
    catch (e) {
      if (p.optionalDependencies?.[name] || p.peerDependenciesMeta?.[name]?.optional) { node.edges[name] = null; continue; }
      throw e;
    }
    node.edges[name] = visit(candidate);
  }
  return file;
}
for (const rel of input.workspaces) {
  const file = path.join(root, rel, 'package.json');
  packages[rel] = metadata(JSON.parse(fs.readFileSync(file)));
  rootFiles[rel] = visit(file);
}
// Yarn peer contexts can install the same name/version with different resolved
// edges. Refine semantic graph classes rather than collapsing by name/version
// or comparing machine-specific paths. Duplicate physical installations and
// dependency cycles are harmless; distinct peer graphs remain distinct.
let colors = new Map([...raw].map(([file,n]) => [file,n.identity]));
for (let round = 0; round <= raw.size; round++) {
  const signatures = new Map([...raw].map(([file,n]) => [file,JSON.stringify({ identity:n.identity,
    edges:Object.fromEntries(Object.entries(n.edges).map(([name,target]) => [name,target === null ? null : colors.get(target)])) })]));
  const labels = [...new Set(signatures.values())].sort();
  const ids = new Map(labels.map((value,index) => [value,String(index)]));
  const next = new Map([...signatures].map(([file,value]) => [file,ids.get(value)]));
  const stable = labels.length === new Set(colors.values()).size;
  colors = next;
  if (stable) break;
  if (round === raw.size) throw new Error('runtime graph did not converge');
}
const key = file => raw.get(file).identity + '#' + colors.get(file);
const nodes = {};
for (const [file,n] of raw) nodes[key(file)] = { identity:n.identity,
  edges:Object.fromEntries(Object.entries(n.edges).map(([name,target]) => [name,target === null ? null : key(target)])) };
const roots = Object.fromEntries(Object.entries(rootFiles).map(([rel,file]) => [rel,key(file)]));
console.log(JSON.stringify({ nodeMajor: Number(process.versions.node.split('.')[0]), nodeABI: process.versions.modules,
  platform:process.platform, arch:process.arch, packages, roots, nodes }));
"""
IMPORT_PROBE = r"""
const path = require('node:path'), input = JSON.parse(process.argv[1]);
for (const w of input.workspaces) {
  const m = require(path.join(input.root, w.path, w.package.main));
  const plugin = m?.default ?? m;
  if (w.role === 'library') {
    if (!m || (typeof m !== 'object' && typeof m !== 'function') || Object.keys(m).length === 0) throw new Error('empty library export');
  } else if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function' && typeof m?.apply !== 'function') {
    throw new Error('plugin export missing');
  }
}
console.log('IMPORT_OK');
"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(path, limit=None):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "missing or linked file: " + path.name)
    h = hashlib.sha256()
    with path.open("rb") as stream:
        remaining = limit
        while remaining is None or remaining > 0:
            block = stream.read(1024 * 1024 if remaining is None else min(1024 * 1024, remaining))
            if not block:
                break
            h.update(block)
            if remaining is not None:
                remaining -= len(block)
    require(limit is None or remaining == 0, "protected file shrank")
    return h.hexdigest()


def file_info(path):
    value = Path(path).stat()
    return {"size": value.st_size, "sha256": digest(path), "mode": stat.S_IMODE(value.st_mode),
            "uid": value.st_uid, "gid": value.st_gid}


def output_path(value, workspaces):
    require(isinstance(value, str) and "\\" not in value and len(value) < 512, "invalid output path")
    parts = PurePosixPath(value).parts
    require(value == str(PurePosixPath(value)) and not value.startswith("/") and
            all(p not in {".", "..", ""} for p in parts), "unsafe output path")
    require(any(value.startswith(w["path"] + "/" + r + "/") for w in workspaces for r in w["outputs"]),
            "output outside workspace dist/lib")
    return value


def safe_target(root, rel):
    root = Path(root)
    target = root / rel
    require(not root.is_symlink() and root.resolve() == root, "unsafe source root")
    require(target.resolve().is_relative_to(root), "path escapes root")
    for part in [target, *target.parents]:
        require(not part.is_symlink(), "linked target path")
        if part == root:
            break
    return target


def validate_manifest(m):
    require(isinstance(m, dict) and m.get("schema") == SCHEMA, "unsupported manifest")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", m.get("repository", "")), "invalid repository")
    require(re.fullmatch(r"[0-9a-f]{40}", m.get("sourceSha", "")), "invalid source SHA")
    require(str(m.get("runId", "")).isdigit(), "invalid run ID")
    require(m.get("workflow") == ".github/workflows/ci.yml" and m.get("event") == "push" and m.get("branch") == "dev",
            "untrusted build provenance")
    require(m.get("yarn") == "4.12.0" and SHA.fullmatch(m.get("lockSha256", "")), "invalid build inputs")
    workspaces = m.get("workspaces")
    require(isinstance(workspaces, list) and 0 < len(workspaces) < 100, "invalid workspace list")
    require(len({w["path"] for w in workspaces}) == len(workspaces), "duplicate workspace")
    for w in workspaces:
        require(WORKSPACE.fullmatch(w["path"]) and w["role"] in {"library", "plugin"}, "invalid workspace/role")
        require(w["outputs"] and len(set(w["outputs"])) == len(w["outputs"]) and set(w["outputs"]) <= {"dist", "lib"}, "invalid output roots")
        main = w["package"].get("main", "").removeprefix("./")
        output_path(w["path"] + "/" + main, workspaces)
    files = m.get("files")
    require(isinstance(files, list) and 0 < len(files) <= MAX_FILES, "invalid file count")
    require(len({f["path"] for f in files}) == len(files), "duplicate output")
    total = 0
    for f in files:
        output_path(f["path"], workspaces)
        require(type(f["size"]) is int and 0 <= f["size"] <= MAX_BYTES and SHA.fullmatch(f["sha256"]), "invalid file metadata")
        total += f["size"]
    require(total <= MAX_BYTES, "output budget exceeded")
    for w in workspaces:
        require(w["path"] + "/" + w["package"]["main"].removeprefix("./") in {f["path"] for f in files}, "main missing from payload")
    runtime = m.get("runtime", {})
    require(type(runtime.get("nodeMajor")) is int and str(runtime.get("nodeABI", "")).isdigit(), "invalid Node runtime")
    require(runtime.get("packages") == {w["path"]: w["package"] for w in workspaces}, "runtime/workspace metadata mismatch")
    require(isinstance(runtime.get("nodes"), dict) and isinstance(runtime.get("roots"), dict), "missing runtime graph")
    for asset in ("payload", "runner"):
        a = m.get(asset, {})
        require(type(a.get("size")) is int and 0 < a["size"] <= MAX_BYTES and SHA.fullmatch(a.get("sha256", "")), "invalid control asset")
    return m


def validate_archive(archive, entries, destination=None):
    """Never extractall: accept exactly the declared regular-file members."""
    expected = {f["path"]: f for f in entries}
    require(len(expected) == len(entries) and len(entries) <= MAX_FILES, "duplicate/oversized archive plan")
    seen = set()
    total = 0
    for member in archive:
        require(member.isfile() and member.name in expected and member.name not in seen, "unexpected, duplicate or linked TAR member")
        entry = expected[member.name]
        require(member.size == entry["size"], "TAR member size mismatch")
        total += member.size
        require(total <= MAX_BYTES, "TAR budget exceeded")
        seen.add(member.name)
        stream = archive.extractfile(member)
        h = hashlib.sha256()
        target = None
        if destination is not None:
            target = safe_target(Path(destination), member.name)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        out = target.open("xb") if target else None
        try:
            remaining = member.size
            while remaining:
                block = stream.read(min(1024 * 1024, remaining))
                require(block, "truncated TAR member")
                remaining -= len(block)
                h.update(block)
                if out:
                    out.write(block)
        finally:
            if out:
                out.close()
            stream.close()
        require(h.hexdigest() == entry["sha256"], "TAR member hash mismatch")
    require(seen == set(expected), "missing TAR member")


def command(args, timeout=120):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    require(result.returncode == 0, "command failed: " + str(args[0]) + " / " + str(result.returncode))
    return result.stdout.decode("utf-8", "replace")


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("xb") as stream:
        stream.write(canonical(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)
    if os.name == "posix":
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def inspect(name):
    v = json.loads(command(["docker", "inspect", name]))[0]
    s = v["State"]
    return {"id": v["Id"], "image": v["Image"], "status": s["Status"], "startedAt": s["StartedAt"],
            "exitCode": s["ExitCode"], "oomKilled": s["OOMKilled"], "restartCount": v["RestartCount"]}


def severe_startup_count(text):
    # Trust only explicit error/fatal logger prefixes. A raw `SyntaxError:` line
    # may be ordinary multi-line chat/debug content and must not trigger rollback.
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    context = re.compile(r"^(?:\d{4}-\d\d-\d\d[T ][0-9:.+Z-]+\s*)?(?:\[(?:E|F|ERROR|FATAL)\]|ERROR\b|FATAL\b)")
    pattern = re.compile(r"Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|SyntaxError|ReferenceError|UnhandledPromiseRejection|EADDRINUSE")
    return sum(bool(context.search(line.lstrip())) and bool(pattern.search(line)) for line in text.splitlines())


def changed_plan(files, current, previous=None):
    new = {f["path"]: f for f in files}
    if previous is None:
        require(set(current) <= set(new), "unknown output ownership; explicit upgrade required")
    else:
        old = previous["files"]
        require(set(current) == set(old), "foreign added/deleted output")
        require(all(current[p]["sha256"] == old[p]["sha256"] for p in old), "foreign output change")
    writes = [f for p, f in new.items() if p not in current or current[p]["sha256"] != f["sha256"]]
    deletes = sorted(set(current) - set(new))
    return {"write": writes, "delete": deletes}


class Deployment:
    def __init__(self, run_dir, profile, manifest=None):
        self.run = Path(run_dir)
        self.profile = profile
        self.source = Path(profile["sourceRoot"])
        self.data = Path(profile["dataRoot"])
        self.state = Path(profile["stateRoot"])
        self.config = Path(profile["configPath"])
        self.koishi = profile["container"]
        self.napcat = profile["napcat"]
        self.manifest = validate_manifest(manifest) if manifest else None
        self.stage = self.run / "stage"
        self.ledger = None

    def guard_host(self):
        p = self.profile
        require(os.geteuid() == 0 and socket.gethostname() == p["hostname"], "SSH host/user mismatch")
        for key in ("container", "napcat"):
            require(re.fullmatch(r"[a-zA-Z0-9_-]+", p[key]), "unsafe container name")
        for root in (self.source, self.data, self.state, self.run):
            require(root.is_absolute() and root.resolve() == root and not root.is_symlink(), "unsafe root path")
        require(not self.state.is_relative_to(self.source) and not self.state.is_relative_to(self.data) and
                not self.source.is_relative_to(self.state) and not self.data.is_relative_to(self.state), "state overlaps app/data")
        require(not self.source.is_relative_to(self.data) and not self.data.is_relative_to(self.source), "business data overlaps source root")
        require(self.source.is_dir() and self.data.is_dir() and self.config.is_file() and
                self.config.resolve() == self.config, "missing/linked application roots or config")
        require(safe_target(self.data, "channels").is_dir(), "missing business channels root")
        require(self.run.parent == self.state / "runs", "run outside state root")
        for root in (self.state, self.state / "runs", self.run):
            require(root.is_dir() and root.stat().st_uid == 0 and stat.S_IMODE(root.stat().st_mode) == 0o700, "unsafe release state permissions")
        require(re.fullmatch(r"https?://127\.0\.0\.1:\d+/[^\s]*", p["healthUrl"]), "unsafe health URL")

    def source_state(self):
        args = ["git", "-C", str(self.source)]
        status = command(args + ["status", "--porcelain"])
        diff = command(args + ["diff", "--no-ext-diff", "--binary", "HEAD"])
        return {"head": command(args + ["rev-parse", "HEAD"]).strip(), "dirtyCount": len(status.splitlines()),
                "statusSha256": hashlib.sha256(status.encode()).hexdigest(), "diffSha256": hashlib.sha256(diff.encode()).hexdigest()}

    def container_node(self, script, value):
        image = inspect(self.koishi)["image"]
        return command(["docker", "run", "--rm", "--network", "none", "--read-only", "--volumes-from", self.koishi + ":ro",
                        "--workdir", self.profile["containerSourceRoot"], "--entrypoint", "node", image, "-e", script, canonical(value).decode()], 180)

    def compatibility(self):
        workspaces = self.manifest["workspaces"]
        actual = json.loads(self.container_node(RUNTIME_PROBE, {"root": self.profile["containerSourceRoot"],
                                                              "workspaces": [w["path"] for w in workspaces]}))
        require(actual == self.manifest["runtime"], "runtime/workspace/Node ABI mismatch; explicit dependency upgrade required")
        return hashlib.sha256(canonical(actual)).hexdigest()

    def inventory(self):
        result = {}
        for w in self.manifest["workspaces"]:
            for output in w["outputs"]:
                root = safe_target(self.source, w["path"] + "/" + output)
                require(root.is_dir(), "missing workspace output root; explicit upgrade required")
                for path in sorted(root.rglob("*")):
                    rel = path.relative_to(self.source).as_posix()
                    safe_target(self.source, rel)
                    require(path.is_file() or path.is_dir(), "unsafe output node")
                    if path.is_file():
                        require(len(result) < MAX_FILES, "inventory budget exceeded")
                        result[rel] = file_info(path)
        return result

    def snapshot(self):
        return {"koishi": inspect(self.koishi), "napcat": inspect(self.napcat),
                "configSha256": digest(self.config), "source": self.source_state()}

    def guards(self, before, running, restart=False, napcat=True):
        now = self.snapshot()
        old = before["koishi"]
        require(now["koishi"]["id"] == old["id"] and now["koishi"]["image"] == old["image"], "container identity changed")
        require(now["koishi"]["status"] == ("running" if running else "exited"), "unexpected container state")
        if running and not restart:
            require(now["koishi"]["startedAt"] == old["startedAt"], "container restarted during preparation")
        require(now["configSha256"] == before["configSha256"] and now["source"] == before["source"], "config/source guard changed")
        if napcat:
            require(now["napcat"] == before["napcat"], "NapCat changed independently")

    def sessions(self):
        result = {}
        channels = safe_target(self.data, "channels")
        require(channels.is_dir(), "missing business channels root")
        for path in sorted(channels.rglob("*.jsonl")):
            rel = path.relative_to(self.data).as_posix()
            safe_target(self.data, rel)
            result[rel] = {"size": path.stat().st_size, "sha256": digest(path)}
        return result

    def sessions_guard(self, snapshot, running):
        if not running:
            require(self.sessions() == snapshot, "sessions changed while stopped")
        else:
            for rel, info in snapshot.items():
                require(digest(safe_target(self.data, rel), info["size"]) == info["sha256"], "old session prefix changed")
        return {"protectedFiles": len(snapshot), "oldPrefixesUnchanged": True}

    def healthy(self):
        consecutive = 0
        for _ in range(60):
            value = inspect(self.koishi)
            require(value["status"] not in {"exited", "dead"} and not value["oomKilled"], "container exited/OOM")
            try:
                code = command(["curl", "-sS", "--max-time", "3", "-o", "/dev/null", "-w", "%{http_code}", self.profile["healthUrl"]], 5)
            except RuntimeError:
                code = ""
            consecutive = consecutive + 1 if code == "200" and value["status"] == "running" else 0
            if consecutive >= 3:
                return
            time.sleep(1)
        raise RuntimeError("health check timed out")

    def loadable(self):
        require("IMPORT_OK" in self.container_node(IMPORT_PROBE, {"root": self.profile["containerSourceRoot"], "workspaces": self.manifest["workspaces"]}), "import confirmation missing")

    def previous(self):
        path = self.state / "release-state.json"
        return read_json(path) if path.exists() else None

    def preflight(self):
        previous = self.previous()
        pending = self.state / "pending.json"
        require(not pending.exists(), "unfinished deployment; use status/recover before deploy")
        if previous:
            require(previous["workspacePaths"] == [w["path"] for w in self.manifest["workspaces"]], "workspace set changed; explicit upgrade required")
        fingerprint = self.compatibility()
        before = self.snapshot()
        require(before["koishi"]["status"] == "running" and before["napcat"]["status"] == "running", "service not running")
        files = self.inventory()
        plan = changed_plan(self.manifest["files"], files, previous)
        self.healthy()
        self.guards(before, True)
        value = {"before": before, "files": files, "runtimeSha256": fingerprint, "previous": previous}
        return value, plan, hashlib.sha256(canonical(value)).hexdigest()

    def save_ledger(self, phase):
        self.ledger["phase"] = phase
        atomic_json(self.run / "ledger.json", self.ledger)
        atomic_json(self.state / "pending.json", {"run": self.run.name})

    def replace(self, source, rel, info):
        target = safe_target(self.source, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + "." + self.run.name + ".tmp")
        require(not temp.exists() and not temp.is_symlink(), "temporary target exists")
        try:
            with Path(source).open("rb") as src, temp.open("xb") as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            shutil.copystat(source, temp)
            os.chown(temp, info["uid"], info["gid"])
            temp.chmod(info["mode"])
            os.replace(temp, target)
            fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            if temp.exists():
                temp.unlink()

    def verify_outputs(self, expected):
        current = self.inventory()
        require(set(current) == set(expected) and all(current[p]["sha256"] == expected[p]["sha256"] for p in current), "foreign output change")

    def verify_output_target(self, rel, expected):
        target = safe_target(self.source, rel)
        if expected is None:
            require(not target.exists(), "foreign output change")
        else:
            require(target.is_file() and digest(target) == expected["sha256"], "foreign output change")

    def verify_rollback_targets(self, old, new):
        for rel in set(old) | set(new):
            path = safe_target(self.source, rel)
            current = digest(path) if path.exists() else None
            allowed = {old.get(rel, {}).get("sha256"), new.get(rel, {}).get("sha256")}
            require(current in allowed, "foreign target change; rollback refused")
            if rel in old:
                require(digest(self.run / "app-before" / rel) == old[rel]["sha256"], "backup corrupted")

    def rollback(self, explicit=False):
        ledger = self.ledger or read_json(self.run / "ledger.json")
        self.ledger = ledger
        before, old = ledger["before"], ledger["oldFiles"]
        new = {f["path"]: f for f in self.manifest["files"]}
        now = inspect(self.koishi)
        require(now["id"] == before["koishi"]["id"] and now["image"] == before["koishi"]["image"], "rollback container changed")
        if ledger["phase"] == "rolled_back":
            self.verify_outputs(old)
            self.healthy()
            return {"status": "already_rolled_back"}
        require(not explicit or self.previous().get("lastActivatedRun") == self.run.name, "not latest activated release")
        # Verify all backup and target bytes before the first overwrite. Independent
        # NapCat/config changes never block restarting/restoring our old app.
        self.verify_rollback_targets(old, new)
        if now["status"] == "running":
            try:
                command(["docker", "stop", "--time", "30", self.koishi], 60)
            except (RuntimeError, subprocess.TimeoutExpired):
                # A command can time out after Docker has actually stopped it.
                require(inspect(self.koishi)["status"] == "exited", "rollback stop failed")
        require(inspect(self.koishi)["status"] == "exited", "rollback stop failed")
        # Recheck after stop: a foreign writer may have changed an output during
        # the stop window. Keep a pending ledger rather than overwriting it.
        self.save_ledger("rollback_requested")
        self.verify_rollback_targets(old, new)
        sessions = self.sessions()
        for rel in sorted(set(old) | set(new)):
            path = safe_target(self.source, rel)
            if rel in old:
                if not path.exists() or digest(path) != old[rel]["sha256"]:
                    self.replace(self.run / "app-before" / rel, rel, old[rel])
            elif path.exists():
                path.unlink()
        self.verify_outputs(old)
        self.sessions_guard(sessions, False)
        try:
            command(["docker", "start", self.koishi])
        except (RuntimeError, subprocess.TimeoutExpired):
            require(inspect(self.koishi)["status"] == "running", "rollback restart failed")
        self.healthy()
        self.sessions_guard(sessions, True)
        previous = ledger["previous"]
        statefile = self.state / "release-state.json"
        if previous is not None:
            atomic_json(statefile, previous)
        elif statefile.exists():
            statefile.unlink()
        ledger["phase"] = "rolled_back"
        atomic_json(self.run / "ledger.json", ledger)
        if (self.state / "pending.json").exists():
            (self.state / "pending.json").unlink()
        return {"status": "rolled_back", "run": self.run.name, "http": 200, "dataRestore": False,
                "napcatUnchanged": inspect(self.napcat) == before["napcat"]}

    def deploy(self, expected_inventory, stream):
        value, plan, marker = self.preflight()
        require(marker == expected_inventory, "inventory changed since preview; retry dry-run")
        new = {f["path"]: f for f in self.manifest["files"]}
        if not plan["write"] and not plan["delete"]:
            self.loadable()
            self.guards(value["before"], True)
            self.verify_outputs(new)
            previous = value["previous"] or {}
            state = {**previous, "sourceSha": self.manifest["sourceSha"], "files": value["files"],
                     "workspacePaths": [w["path"] for w in self.manifest["workspaces"]],
                     "manifestSha256": hashlib.sha256(canonical(self.manifest)).hexdigest()}
            # Preserve lastActivatedRun: a no-op has no rollback backup/restart.
            atomic_json(self.state / "release-state.json", state)
            return {"status": "no_op", "sourceSha": self.manifest["sourceSha"], "restart": False, "http": 200}
        required = sum(f["size"] for f in plan["write"]) + sum(f["size"] for f in value["files"].values())
        require(shutil.disk_usage(self.state).free > required * 2 + 64 * 1024 * 1024, "insufficient stage/backup space")
        self.stage.mkdir(mode=0o700)
        # The SSH receiver owns the lock while receiving AND activating. TAR stdin
        # is not also used as Python source; delta entries derive from manifest.
        with tarfile.open(fileobj=stream, mode="r|gz") as archive:
            validate_archive(archive, plan["write"], self.stage)
        for rel, info in value["files"].items():
            destination = self.run / "app-before" / rel
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(safe_target(self.source, rel), destination)
            require(digest(destination) == info["sha256"], "backup changed/corrupted")
        self.guards(value["before"], True)
        self.verify_outputs(value["files"])
        self.ledger = {"before": value["before"], "oldFiles": value["files"], "previous": value["previous"], "phase": "prepared"}
        self.save_ledger("prepared")
        try:
            self.save_ledger("stop_requested")
            command(["docker", "stop", "--time", "30", self.koishi], 60)
            self.guards(value["before"], False)
            # Recheck outputs after the service is stopped and before any write;
            # ignored build files are outside the source Git diff guard.
            self.verify_outputs(value["files"])
            sessions = self.sessions()
            self.ledger["sessions"] = sessions
            self.save_ledger("applying")
            for f in plan["write"]:
                self.verify_output_target(f["path"], value["files"].get(f["path"]))
                parent_path = safe_target(self.source, f["path"]).parent
                while not parent_path.exists():
                    parent_path = parent_path.parent
                parent = parent_path.stat()
                info = value["files"].get(f["path"], {"mode": 0o644, "uid": parent.st_uid, "gid": parent.st_gid})
                self.replace(self.stage / f["path"], f["path"], info)
            for rel in plan["delete"]:
                self.verify_output_target(rel, value["files"].get(rel))
                safe_target(self.source, rel).unlink()
            self.verify_outputs(new)
            self.sessions_guard(sessions, False)
            self.loadable()
            self.guards(value["before"], False)
            self.sessions_guard(sessions, False)
            self.save_ledger("start_requested")
            since = str(int(time.time()))
            command(["docker", "start", self.koishi])
            self.healthy()
            self.guards(value["before"], True, restart=True)
            current = inspect(self.koishi)
            require(current["exitCode"] == 0 and not current["oomKilled"] and current["restartCount"] == value["before"]["koishi"]["restartCount"], "bad final container state")
            logs = subprocess.run(["docker", "logs", "--since", since, self.koishi], capture_output=True, timeout=30)
            require(logs.returncode == 0 and severe_startup_count((logs.stdout + logs.stderr).decode("utf-8", "replace")) == 0, "startup log validation failed")
            del logs
            self.verify_outputs(new)
            sessions_result = self.sessions_guard(sessions, True)
            state = {"sourceSha": self.manifest["sourceSha"], "files": self.inventory(),
                     "workspacePaths": [w["path"] for w in self.manifest["workspaces"]], "lastActivatedRun": self.run.name,
                     "manifestSha256": hashlib.sha256(canonical(self.manifest)).hexdigest()}
            atomic_json(self.state / "release-state.json", state)
            self.ledger["result"] = {"status": "activated", "run": self.run.name, "sourceSha": self.manifest["sourceSha"], "http": 200,
                                    "container": current, "sessions": sessions_result, "configUnchanged": True, "sourceUnchanged": True,
                                    "napcatUnchanged": True, "written": len(plan["write"]), "deleted": len(plan["delete"])}
            self.save_ledger("complete")
            (self.state / "pending.json").unlink()
        except BaseException:
            # Disable repeat signals during recovery. SIGKILL/power loss leaves the
            # pending ledger for explicit recovery under the next kernel lock.
            for signum in HANDLED_SIGNALS:
                signal.signal(signum, signal.SIG_IGN)
            try:
                self.rollback()
            except BaseException as error:
                atomic_json(self.run / "recovery-error.json", {"error": str(error), "status": "rollback_incomplete"})
            raise
        result = self.ledger["result"]
        try:
            shutil.rmtree(self.stage)
        except OSError:
            result["cleanupWarning"] = True
        atomic_json(self.run / "result.json", result)
        return result


@contextmanager
def target_lock(state, source=None):
    import fcntl  # Linux-only owner; contract and local CLI work on Windows.
    # Alternate state directories must not allow two writers for the same app.
    # Production locks are keyed by canonical source root in a host-wide root
    # lock namespace; tests use their owned temporary state directory.
    if source is not None:
        require(os.geteuid() == 0 and Path(source).resolve() == Path(source), "unsafe global target lock")
        key = hashlib.sha256(str(source).encode()).hexdigest()
        path = Path("/run/lock") / ("yesimbot-release-" + key + ".lock")
    else:
        path = Path(state) / "deploy.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as stream:
        info = os.fstat(stream.fileno())
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600, "unsafe deployment lock")
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("another deployment owns the target lock") from None
        yield


def remote_main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inventory", "deploy", "status", "recover", "rollback", "verify"])
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--inventory-sha")
    args = parser.parse_args()
    os.umask(0o077)
    run = Path(args.run_dir)
    profile = read_json(run / "profile.json")
    m = read_json(run / "manifest.json")
    owner = Deployment(run, profile, m)
    owner.guard_host()
    require(digest(run / "runner.py") == m["runner"]["sha256"], "remote runner hash mismatch")
    with target_lock(owner.state, owner.source):
        if args.action in {"recover", "rollback"}:
            state = owner.previous() or {}
            pending = read_json(owner.state / "pending.json") if (owner.state / "pending.json").exists() else {}
            name = pending.get("run") if args.action == "recover" else state.get("lastActivatedRun")
            require(name and re.fullmatch(r"[0-9a-f]{32}", name), "no recoverable/rollback deployment")
            prior_run = owner.state / "runs" / name
            prior = Deployment(prior_run, read_json(prior_run / "profile.json"), read_json(prior_run / "manifest.json"))
            prior.guard_host()
            result = prior.rollback(explicit=args.action == "rollback")
        elif args.action == "status":
            result = {"status": "pending" if (owner.state / "pending.json").exists() else "ready", "release": owner.previous(), "container": inspect(owner.koishi)}
        elif args.action in {"inventory", "verify"}:
            value, plan, marker = owner.preflight()
            if args.action == "verify":
                require(not plan["write"] and not plan["delete"], "release outputs not active")
                owner.loadable()
            result = {"status": "verified" if args.action == "verify" else "planned", "inventorySha256": marker,
                      "plan": plan, "sourceSha": m["sourceSha"], "container": value["before"]["koishi"], "http": 200}
        else:
            def interrupted(signum, _frame):
                raise RuntimeError("deployment interrupted by signal " + str(signum))
            for signum in HANDLED_SIGNALS:
                signal.signal(signum, interrupted)
            result = owner.deploy(args.inventory_sha, sys.stdin.buffer)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        remote_main()
    except BaseException as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
