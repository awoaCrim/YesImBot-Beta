"""Standard-library release tests; no production credentials or business traffic."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release as cli
import release_runner as runner


def entry(path, data):
    return {"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def manifest(files=None):
    package = {"name": "example-plugin", "version": "1.0.0", "main": "./dist/index.cjs"}
    return {"schema": 1, "repository": cli.REPOSITORY, "sourceSha": "a" * 40, "runId": "123",
            "workflow": ".github/workflows/ci.yml", "event": "push", "branch": "dev", "yarn": "4.12.0", "lockSha256": "b" * 64,
            "workspaces": [{"path": "core", "role": "plugin", "outputs": ["dist"], "package": package}],
            "runtime": {"nodeMajor": 24, "nodeABI": "137", "packages": {"core": package}, "roots": {}, "nodes": {}},
            "files": files or [entry("core/dist/index.cjs", b"new")],
            "runner": {"size": 1, "sha256": "c" * 64}, "payload": {"size": 1, "sha256": "d" * 64}}


def archive_bytes(members, compressed=True):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz" if compressed else "w") as archive:
        for name, data, kind in members:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            if kind is not None:
                member.type = kind
                member.linkname = "../../outside"
            archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


class ContractTests(unittest.TestCase):
    def test_valid_manifest(self):
        self.assertEqual(runner.validate_manifest(manifest())["sourceSha"], "a" * 40)

    def test_manifest_rejects_bad_provenance_paths_hash_sizes_and_roles(self):
        changes = [("schema", 2), ("sourceSha", "x"), ("runId", "1;echo x"), ("repository", "bad"),
                   ("event", "pull_request"), ("branch", "other"), ("workflow", "other.yml"), ("yarn", "latest")]
        for key, value in changes:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m = manifest()
                m[key] = value
                runner.validate_manifest(m)
        for path in ("../escape", "/core/dist/index.cjs", "core/dist/../file", "core/src/file", "core\\dist\\file", "core/dist//file"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                runner.validate_manifest(manifest([entry(path, b"new")]))
        for key, value in (("size", -1), ("size", runner.MAX_BYTES + 1), ("size", True), ("sha256", "x")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                m = manifest()
                m["files"][0][key] = value
                runner.validate_manifest(m)
        for mutate in (lambda m: m["files"].append(m["files"][0]),
                       lambda m: m["workspaces"][0].update(role="unknown"),
                       lambda m: m["workspaces"][0].update(outputs=["src"]),
                       lambda m: m["runtime"].update(packages={})):
            with self.assertRaises(RuntimeError):
                m = manifest()
                mutate(m)
                runner.validate_manifest(m)

    def test_console_lib_and_dist_are_valid_and_main_required(self):
        m = manifest([entry("plugins/console/lib/index.js", b"main"), entry("plugins/console/dist/app.js", b"client")])
        m["workspaces"] = [{"path": "plugins/console", "role": "plugin", "outputs": ["lib", "dist"],
                            "package": {"name": "console", "main": "./lib/index.js"}}]
        m["runtime"]["packages"] = {"plugins/console": m["workspaces"][0]["package"]}
        runner.validate_manifest(m)
        m["files"].pop(0)
        with self.assertRaisesRegex(RuntimeError, "main missing"):
            runner.validate_manifest(m)

    def test_archive_exact_member_hash_and_streaming_extract(self):
        data = archive_bytes([("core/dist/index.cjs", b"new", None)])
        with tempfile.TemporaryDirectory() as directory, tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as archive:
            runner.validate_archive(archive, manifest()["files"], Path(directory).resolve())
            self.assertEqual((Path(directory) / "core/dist/index.cjs").read_bytes(), b"new")

    def test_archive_rejects_links_duplicate_missing_unknown_size_and_hash(self):
        cases = [[("core/dist/index.cjs", b"new", tarfile.SYMTYPE)],
                 [("core/dist/index.cjs", b"new", tarfile.LNKTYPE)],
                 [("../outside", b"new", None)],
                 [("core/dist/index.cjs", b"new", None)] * 2,
                 [], [("core/dist/index.cjs", b"different", None)], [("core/dist/index.cjs", b"bad", None)]]
        for members in cases:
            with self.subTest(members=members), self.assertRaises(RuntimeError), tarfile.open(fileobj=io.BytesIO(archive_bytes(members)), mode="r:gz") as archive:
                runner.validate_archive(archive, manifest()["files"])

    def test_safe_target_rejects_traversal_and_symlink_ancestor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with self.assertRaises(RuntimeError):
                runner.safe_target(root, "../outside")
            if os.name == "posix":
                (root / "linked").symlink_to(root, target_is_directory=True)
                with self.assertRaises(RuntimeError):
                    runner.safe_target(root, "linked/file")

    def test_archive_budget_even_when_entries_are_unvalidated(self):
        e = entry("core/dist/index.cjs", b"new")
        with patch.object(runner, "MAX_BYTES", 2), self.assertRaises(RuntimeError), tarfile.open(fileobj=io.BytesIO(archive_bytes([(e["path"], b"new", None)])), mode="r:gz") as archive:
            runner.validate_archive(archive, [e])

    def test_runtime_graph_resolves_required_peers_not_dev_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "core").mkdir()
            p = {"name": "test", "version": "1", "main": "./dist/index.cjs", "peerDependencies": {"peer": "^1"}, "devDependencies": {"absent-dev": "^1"}}
            (root / "core/package.json").write_text(json.dumps(p))
            dep = root / "node_modules/peer"
            dep.mkdir(parents=True)
            (dep / "package.json").write_text(json.dumps({"name": "peer", "version": "1.2.3"}))
            value = cli.runtime_fingerprint(root, [{"path": "core"}])
            node = value["nodes"][value["roots"]["core"]]
            self.assertTrue(node["edges"]["peer"].startswith("peer@1.2.3#"))
            (dep / "package.json").unlink()
            with self.assertRaises(RuntimeError):
                cli.runtime_fingerprint(root, [{"path": "core"}])

    def test_named_library_direct_class_default_and_apply_exports(self):
        exports = [("library", "exports.createAgent = () => {};"), ("plugin", "module.exports = class Plugin {};"),
                   ("plugin", "exports.default = class Plugin {};"), ("plugin", "exports.apply = () => {};"),
                   ("plugin", "exports.default = { apply() {} }; ")]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            main = root / "core/dist/index.cjs"
            main.parent.mkdir(parents=True)
            for role, code in exports:
                main.write_text(code)
                v = {"root": str(root), "workspaces": [{"path": "core", "role": role, "package": {"main": "./dist/index.cjs"}}]}
                self.assertIn("IMPORT_OK", runner.command(["node", "-e", runner.IMPORT_PROBE, json.dumps(v)]))
            main.write_text("module.exports = {};")
            with self.assertRaises(RuntimeError):
                runner.command(["node", "-e", runner.IMPORT_PROBE, json.dumps(v)])

    def test_startup_error_names_in_chat_do_not_trigger_rollback(self):
        self.assertEqual(runner.severe_startup_count("[I] chat user says SyntaxError: example\nSyntaxError: quoted line\n[D] quoted MODULE_NOT_FOUND"), 0)
        self.assertEqual(runner.severe_startup_count("[I] chat user quotes ERROR SyntaxError and [E] MODULE_NOT_FOUND"), 0)
        for text in ("[E] app SyntaxError: Unexpected token", "[E] app Cannot find module 'x'", "ERROR app ERR_REQUIRE_ESM", "FATAL EADDRINUSE"):
            self.assertEqual(runner.severe_startup_count(text), 1)

    def test_change_plan_rejects_foreign_writes_and_allows_owned_deletions(self):
        old = {"core/dist/index.cjs": entry("core/dist/index.cjs", b"old")}
        plan = runner.changed_plan(manifest()["files"], old)
        self.assertEqual(len(plan["write"]), 1)
        old["core/dist/obsolete"] = entry("core/dist/obsolete", b"old")
        with self.assertRaisesRegex(RuntimeError, "unknown output"):
            runner.changed_plan(manifest()["files"], old)
        plan = runner.changed_plan(manifest()["files"], old, {"files": copy.deepcopy(old)})
        self.assertEqual(plan["delete"], ["core/dist/obsolete"])
        previous = {"files": copy.deepcopy(old)}
        old["core/dist/index.cjs"]["sha256"] = "c" * 64
        with self.assertRaisesRegex(RuntimeError, "foreign"):
            runner.changed_plan(manifest()["files"], old, previous)

    def test_prefix_digest_rejects_shrink_and_changed_prefix_but_allows_append(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "session"
            p.write_bytes(b"old")
            old = runner.digest(p)
            p.write_bytes(b"oldappend")
            self.assertEqual(runner.digest(p, 3), old)
            p.write_bytes(b"ol")
            with self.assertRaises(RuntimeError):
                runner.digest(p, 3)


class GitHubTests(unittest.TestCase):
    def test_only_successful_same_repo_ci_push_dev_is_trusted(self):
        run = {"repository": {"full_name": cli.REPOSITORY}, "head_repository": {"full_name": cli.REPOSITORY},
               "event": "push", "head_branch": "dev", "status": "completed", "conclusion": "success", "workflow_id": 3, "head_sha": "a" * 40}
        workflow = {"id": 3, "path": ".github/workflows/ci.yml"}
        self.assertEqual(cli.trusted_run(run, workflow, cli.REPOSITORY), "a" * 40)
        for key, value in (("event", "pull_request"), ("head_branch", "v4"), ("conclusion", "failure"),
                           ("status", "in_progress"), ("workflow_id", 99), ("head_repository", {"full_name": "foreign/repo"})):
            changed = {**run, key: value}
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                cli.trusted_run(changed, workflow, cli.REPOSITORY)
        with self.assertRaises(RuntimeError):
            cli.trusted_run(run, {**workflow, "path": "other.yml"}, cli.REPOSITORY)

    def test_artifact_zip_is_exactly_three_sidecars_not_arbitrary_extract(self):
        for names, succeeds in ((sorted(cli.ASSETS), True), (list(cli.ASSETS) + ["../outside"], False), (["runner.py"] * 3, False)):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                for name in names:
                    archive.writestr(name, b"test")
            with tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "bundle"
                if succeeds:
                    cli.unpack_artifact(stream.getvalue(), target)
                    self.assertEqual({p.name for p in target.iterdir()}, cli.ASSETS)
                else:
                    with self.assertRaises(RuntimeError):
                        cli.unpack_artifact(stream.getvalue(), target)

    def test_credentials_never_follow_redirect(self):
        import urllib.request
        request = urllib.request.Request("https://api.github.com/file", headers={"Authorization": "Bearer secret"})
        redirected = cli.SafeRedirect().redirect_request(request, None, 302, "redirect", {}, "https://objects.githubusercontent.com/file")
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaises(RuntimeError):
            cli.SafeRedirect().redirect_request(request, None, 302, "redirect", {}, "http://insecure/file")

    def test_repository_and_ssh_alias_cannot_inject_shell(self):
        for repository in ("x/y/../../z", "x;echo/y", "https://github.com/x/y"):
            with self.assertRaises(RuntimeError):
                cli.GitHub(repository)
        for alias in ("-oProxyCommand=evil", "ssh1;echo", "user@host"):
            with self.assertRaises(RuntimeError):
                cli.ssh_call(alias, ["true"])

    def test_cli_help_exits_successfully(self):
        scripts = Path(__file__).resolve().parents[1]
        for script in (scripts / "release.py", scripts / "release_runner.py"):
            with self.subTest(script=script.name):
                result = subprocess.run([sys.executable, str(script), "--help"], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("usage:", result.stdout.lower())


class FakeDeployment(runner.Deployment):
    def __init__(self, root, old=b"old", extras=None):
        self.temp_root = root
        source, data, state = root / "source", root / "data", root / "state"
        run = state / "runs" / ("a" * 32)
        for p in (source / "core/dist", data / "channels", run):
            p.mkdir(parents=True)
        (source / "core/dist/index.cjs").write_bytes(old)
        for rel, content in (extras or {}).items():
            p = source / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(content)
        (data / "channels/session.jsonl").write_bytes(b"private old session\n")
        config = root / "koishi.yml"
        config.write_bytes(b"private config")
        super().__init__(run, {"sourceRoot": str(source), "dataRoot": str(data), "stateRoot": str(state), "configPath": str(config),
                               "container": "koishi", "napcat": "napcat", "healthUrl": "http://127.0.0.1:15140/", "containerSourceRoot": "/app", "hostname": "test"}, manifest())
        self.world = {"koishi": {"id": "id", "image": "image", "status": "running", "startedAt": "old-start", "exitCode": 0, "oomKilled": False, "restartCount": 0},
                      "napcat": {"id": "napcat", "status": "running", "startedAt": "napcat-start"}}
        self.calls = []
        self.fail = None
        self.health_calls = 0
        self.load_calls = 0
        self.foreign = False

    def source_state(self):
        return {"head": "source-head", "statusSha256": "unchanged", "dirtyCount": 0, "diffSha256": "unchanged"}

    def compatibility(self):
        if self.fail == "compatibility":
            raise RuntimeError("runtime mismatch")
        return "runtime-fingerprint"

    def healthy(self):
        self.health_calls += 1
        if self.fail == "health" and self.health_calls == 3:
            raise RuntimeError("health failed")

    def loadable(self):
        self.load_calls += 1
        if self.fail == "import":
            raise RuntimeError("import failed")
        if self.fail == "foreign":
            (self.source / "core/dist/index.cjs").write_bytes(b"foreign")
            raise RuntimeError("foreign")
        if self.fail == "napcat":
            self.world["napcat"]["startedAt"] = "changed independently"
        if self.fail == "config":
            self.config.write_bytes(b"external config")
        if self.fail == "session":
            (self.data / "channels/session.jsonl").write_bytes(b"external session write")

    def replace(self, source, rel, info):
        target = runner.safe_target(self.source, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil_copy = Path(source).read_bytes()
        target.write_bytes(shutil_copy)
        target.chmod(info["mode"])
        if self.fail == "replace" and source.is_relative_to(self.stage):
            raise RuntimeError("replace failed after apply")

    def execute(self, args, timeout=120):
        self.calls.append(args[:])
        if args[:2] == ["docker", "stop"]:
            self.world["koishi"]["status"] = "exited"
            if self.fail in {"foreign_after_stop", "foreign_rollback_after_stop"}:
                (self.source / "core/dist/index.cjs").write_bytes(b"foreign")
            if self.fail == "stop":
                self.fail = None
                raise RuntimeError("stop timed out but actually stopped")
        elif args[:2] == ["docker", "start"]:
            self.world["koishi"].update(status="running", startedAt="new-start")
        return ""

    def patches(self):
        return patch.object(runner, "inspect", side_effect=lambda name: copy.deepcopy(self.world[name])), patch.object(runner, "command", side_effect=self.execute)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.signals = patch.object(runner.signal, "signal")
        self.signals.start()
        self.addCleanup(self.signals.stop)

    def run_owner(self, owner):
        value, plan, marker = owner.preflight()
        members = [(f["path"], b"new", None) for f in plan["write"]]
        return owner.deploy(marker, io.BytesIO(archive_bytes(members)))

    def test_success_then_explicit_application_only_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"[I] chat SyntaxError", b"")):
                result = self.run_owner(owner)
                self.assertEqual(result["status"], "activated")
                self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"new")
                self.assertFalse((owner.state / "pending.json").exists())
                result = owner.rollback(explicit=True)
                self.assertEqual(result["status"], "rolled_back")
                self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"old")
                self.assertEqual(owner.config.read_bytes(), b"private config")
                self.assertEqual((owner.data / "channels/session.jsonl").read_bytes(), b"private old session\n")
                self.assertEqual(owner.world["napcat"]["startedAt"], "napcat-start")

    def test_noop_does_not_stop_or_replace_last_activation_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve(), old=b"new")
            previous = {"files": owner.inventory(), "workspacePaths": ["core"], "lastActivatedRun": "older-backup"}
            runner.atomic_json(owner.state / "release-state.json", previous)
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch:
                result = self.run_owner(owner)
            self.assertEqual(result["status"], "no_op")
            self.assertEqual(owner.calls, [])
            self.assertEqual(owner.previous()["lastActivatedRun"], "older-backup")
            self.assertFalse((owner.run / "app-before").exists())

    def test_failure_after_stop_replace_import_health_or_guards_restores_old_app(self):
        for failure in ("stop", "replace", "import", "health", "napcat", "config", "session"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                owner = FakeDeployment(Path(directory).resolve())
                owner.fail = failure
                inspect_patch, command_patch = owner.patches()
                with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")):
                    with self.assertRaises(RuntimeError):
                        self.run_owner(owner)
                self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"old")
                self.assertEqual(owner.world["koishi"]["status"], "running")
                self.assertEqual(runner.read_json(owner.run / "ledger.json")["phase"], "rolled_back")
                self.assertFalse((owner.state / "pending.json").exists())
                if failure == "config":
                    self.assertEqual(owner.config.read_bytes(), b"external config")
                if failure == "session":
                    self.assertEqual((owner.data / "channels/session.jsonl").read_bytes(), b"external session write")
                if failure == "napcat":
                    self.assertEqual(owner.world["napcat"]["startedAt"], "changed independently")

    def test_foreign_write_refuses_rollback_and_keeps_persistent_pending_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            owner.fail = "foreign"
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch:
                with self.assertRaises(RuntimeError):
                    self.run_owner(owner)
            self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"foreign")
            self.assertTrue((owner.state / "pending.json").exists())
            self.assertEqual(runner.read_json(owner.run / "recovery-error.json")["status"], "rollback_incomplete")

    def test_foreign_write_after_stop_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            owner.fail = "foreign_after_stop"
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch:
                with self.assertRaisesRegex(RuntimeError, "foreign"):
                    self.run_owner(owner)
            self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"foreign")
            self.assertTrue((owner.state / "pending.json").exists())
            self.assertEqual(runner.read_json(owner.run / "recovery-error.json")["status"], "rollback_incomplete")

    def test_changed_preview_or_incompatible_runtime_never_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch:
                with self.assertRaisesRegex(RuntimeError, "inventory changed"):
                    owner.deploy("wrong-marker", io.BytesIO())
                owner.fail = "compatibility"
                with self.assertRaisesRegex(RuntimeError, "runtime mismatch"):
                    owner.preflight()
            self.assertEqual(owner.calls, [])

    def test_pending_deployment_blocks_new_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            runner.atomic_json(owner.state / "pending.json", {"run": owner.run.name})
            with self.assertRaisesRegex(RuntimeError, "unfinished"):
                owner.preflight()

    def test_owned_additions_and_deletions_are_completely_rolled_back(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve(), extras={"core/dist/obsolete.js": b"old extra"})
            runner.atomic_json(owner.state / "release-state.json", {"files": owner.inventory(), "workspacePaths": ["core"]})
            owner.manifest["files"].append(entry("core/dist/new.js", b"new"))
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")):
                self.run_owner(owner)
                self.assertFalse((owner.source / "core/dist/obsolete.js").exists())
                self.assertTrue((owner.source / "core/dist/new.js").exists())
                owner.rollback(explicit=True)
            self.assertEqual((owner.source / "core/dist/obsolete.js").read_bytes(), b"old extra")
            self.assertFalse((owner.source / "core/dist/new.js").exists())

    def test_cleanup_failure_warns_without_rolling_back_healthy_app(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")), patch.object(runner.shutil, "rmtree", side_effect=OSError("cleanup")):
                result = self.run_owner(owner)
            self.assertTrue(result["cleanupWarning"])
            self.assertEqual(result["status"], "activated")
            self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"new")
            self.assertEqual(runner.read_json(owner.run / "ledger.json")["phase"], "complete")

    def test_startup_fatal_triggers_rollback_but_chat_error_name_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"[E] app MODULE_NOT_FOUND", b"")):
                with self.assertRaisesRegex(RuntimeError, "startup log"):
                    self.run_owner(owner)
            self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"old")


class PipelineTests(unittest.TestCase):
    def test_clean_pack_roundtrip_is_deterministic_and_dirty_checkout_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "core/dist").mkdir(parents=True)
            (root / "plugins/console/lib").mkdir(parents=True)
            (root / "plugins/console/dist").mkdir(parents=True)
            packages = {"core": {"name": "test-core", "version": "1", "main": "./dist/index.cjs", "files": ["dist"]},
                        "plugins/console": {"name": "test-console", "version": "1", "main": "./lib/index.js", "files": ["lib", "dist"]}}
            (root / "package.json").write_text(json.dumps({"workspaces": ["core", "plugins/*"]}))
            (root / "yarn.lock").write_text("# pinned test lock\n")
            (root / ".gitignore").write_text("dist/\nlib/\nbundle*/\n")
            for rel, package in packages.items():
                (root / rel / "package.json").write_text(json.dumps(package))
            for rel in ("core/dist/index.cjs", "plugins/console/lib/index.js", "plugins/console/dist/app.js"):
                (root / rel).write_bytes(b"module.exports = class Plugin {};")
            for args in (["init", "-q"], ["add", "."], ["-c", "user.name=release-test", "-c", "user.email=release-test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "test"]):
                subprocess.run(["git", *args], cwd=root, capture_output=True, check=True)
            source = runner.command(["git", "-C", str(root), "rev-parse", "HEAD"]).strip()
            first, second = root / "bundle1", root / "bundle2"
            cli.pack(root, first, cli.REPOSITORY, source, "123")
            cli.pack(root, second, cli.REPOSITORY, source, "123")
            self.assertEqual(runner.digest(first / "payload.tar.gz"), runner.digest(second / "payload.tar.gz"))
            m = cli.verify(first, cli.REPOSITORY, source, "123")
            self.assertEqual(len(m["files"]), 3)
            self.assertEqual({p.name for p in first.iterdir()}, cli.ASSETS)
            self.assertEqual({w["path"] for w in m["workspaces"]}, set(packages))
            (first / "runner.py").write_bytes(b"tampered")
            with self.assertRaisesRegex(RuntimeError, "hash/size"):
                cli.verify(first)
            (root / "yarn.lock").write_text("dirty")
            with self.assertRaisesRegex(RuntimeError, "dirty"):
                cli.pack(root, root / "bundle3", cli.REPOSITORY, source, "123")

    def test_peer_contexts_and_physical_duplicates_have_semantic_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            def package(rel, value):
                path = root / rel / "package.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(value))
            for rel, name, version in (("core", "test-core", "1"), ("plugins/demo", "test-demo", "1")):
                package(rel, {"name": name, "version": version, "dependencies": {"shared": "1"}})
                package(rel + "/node_modules/shared", {"name": "shared", "version": "1", "peerDependencies": {"peer": "*"}})
            package("core/node_modules/peer", {"name": "peer", "version": "1"})
            package("plugins/demo/node_modules/peer", {"name": "peer", "version": "2"})
            workspaces = [{"path": "core"}, {"path": "plugins/demo"}]
            first = cli.runtime_fingerprint(root, workspaces)
            contexts = [n for n in first["nodes"].values() if n["identity"] == "shared@1"]
            self.assertEqual(len(contexts), 2)
            self.assertNotEqual(contexts[0]["edges"], contexts[1]["edges"])
            # The same semantic resolution in a different installation layout.
            import shutil
            (root / "node_modules").mkdir()
            shutil.move(root / "core/node_modules/shared", root / "node_modules/shared")
            shutil.move(root / "core/node_modules/peer", root / "node_modules/peer")
            second = cli.runtime_fingerprint(root, workspaces)
            self.assertEqual(first, second)

    @unittest.skipUnless(os.name == "posix", "kernel flock is remote/Linux-only")
    def test_single_writer_lock_survives_receive_and_is_released_on_kill(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory).resolve()
            scripts = Path(__file__).resolve().parents[1]
            code = "import sys;sys.path.insert(0,sys.argv[1]);import release_runner as r\nwith r.target_lock(sys.argv[2]):\n print('LOCKED',flush=True)\n sys.stdin.readline()\n"
            process = subprocess.Popen([sys.executable, "-c", code, str(scripts), str(state)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(process.stdout.readline().strip(), "LOCKED")
                with self.assertRaisesRegex(RuntimeError, "owns the target lock"), runner.target_lock(state):
                    pass
                process.kill()
                process.communicate(timeout=10)
                with runner.target_lock(state):
                    self.assertTrue((state / "deploy.lock").exists())
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)

    def test_persistent_ledger_recovers_in_new_owner_without_restoring_business_data(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch:
                value, _, _ = owner.preflight()
                backup = owner.run / "app-before/core/dist/index.cjs"
                backup.parent.mkdir(parents=True)
                backup.write_bytes(b"old")
                owner.ledger = {"before": value["before"], "oldFiles": value["files"], "previous": None, "phase": "applying"}
                owner.save_ledger("applying")
                (owner.source / "core/dist/index.cjs").write_bytes(b"new")
                owner.world["koishi"]["status"] = "exited"
                # Mimic process loss: discard every RAM flag/ledger and reload disk.
                owner.ledger = None
                result = owner.rollback()
                self.assertEqual(result["status"], "rolled_back")
                self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"old")
                self.assertEqual(owner.config.read_bytes(), b"private config")
                self.assertFalse((owner.state / "pending.json").exists())
                self.assertEqual(owner.rollback()["status"], "already_rolled_back")

    def test_rollback_observes_stop_timeout_after_actual_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")), patch.object(runner.signal, "signal"):
                value, plan, marker = owner.preflight()
                owner.deploy(marker, io.BytesIO(archive_bytes([("core/dist/index.cjs", b"new", None)])))
                owner.fail = "stop"
                self.assertEqual(owner.rollback(explicit=True)["status"], "rolled_back")
                self.assertEqual(owner.world["koishi"]["status"], "running")

    def test_rollback_rechecks_targets_after_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = FakeDeployment(Path(directory).resolve())
            inspect_patch, command_patch = owner.patches()
            with inspect_patch, command_patch, patch.object(runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"", b"")), patch.object(runner.signal, "signal"):
                value, plan, marker = owner.preflight()
                owner.deploy(marker, io.BytesIO(archive_bytes([("core/dist/index.cjs", b"new", None)])))
                owner.fail = "foreign_rollback_after_stop"
                with self.assertRaisesRegex(RuntimeError, "foreign"):
                    owner.rollback(explicit=True)
            self.assertEqual((owner.source / "core/dist/index.cjs").read_bytes(), b"foreign")
            self.assertTrue((owner.state / "pending.json").exists())
            self.assertEqual(runner.read_json(owner.run / "ledger.json")["phase"], "rollback_requested")


if __name__ == "__main__":
    unittest.main()
