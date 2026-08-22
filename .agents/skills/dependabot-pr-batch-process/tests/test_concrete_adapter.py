#!/usr/bin/env python3
"""Contract tests for the concrete GH/process adapter with no live calls."""

from __future__ import annotations

import importlib.util
import sys
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

if "batch_process" not in sys.modules:
    spec = importlib.util.spec_from_file_location("batch_process", SCRIPT_DIR / "batch_process.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
if "github_boundary" not in sys.modules:
    spec = importlib.util.spec_from_file_location("github_boundary", SCRIPT_DIR / "github_boundary.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

import batch_process as batch  # noqa: E402
import concrete_adapter as concrete  # noqa: E402


def sha(letter: str) -> str:
    return letter * 40


class Dispatcher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def __call__(self, action: str, payload: dict[str, object]):
        self.calls.append((action, payload))
        if action == "prs.search":
            return {"status": "ok", "data": {"items": [{"number": 1}]}}
        if action == "pr.read":
            return {
                "status": "ok",
                "data": {
                    "number": 1,
                    "html_url": "https://github.com/u7chan/monorepo/pull/1",
                    "state": "open",
                    "draft": False,
                    "merged": False,
                    "labels": [{"name": batch.REQUIRED_LABEL}],
                    "user": {"login": "dependabot[bot]", "type": "Bot"},
                    "base": {"ref": "main", "sha": sha("a")},
                    "head": {"ref": "dependabot/example", "sha": sha("b")},
                    "mergeable": "MERGEABLE",
                },
            }
        if action == "pr.commits.read":
            return {
                "status": "ok",
                "data": [
                    {
                        "sha": sha("b"),
                        "author": {"login": "dependabot[bot]", "type": "Bot"},
                        "committer": {"login": "dependabot[bot]", "type": "Bot"},
                        "parents": [{"sha": sha("a")}],
                        "commit": {"message": "Bump package", "verification": {"verified": True}},
                    }
                ],
            }
        if action == "pr.files.read":
            return {"status": "ok", "data": [{"filename": "projects/example/package.json"}]}
        if action == "comments.read":
            return {"status": "ok", "data": {"items": []}}
        if action == "pr.checks.read":
            return {"status": "ok", "data": []}
        raise AssertionError(f"unexpected dispatcher action: {action}")


class FixedApiStub:
    def __init__(self) -> None:
        self.calls: list[tuple[object, dict[str, object]]] = []

    def execute(self, operation, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append((operation, kwargs))
        if operation is concrete.FixedOperation.READ_COMMIT:
            commit_sha = kwargs["commit_sha"]
            return SimpleNamespace(payload={
                "sha": commit_sha,
                "author": {"login": "dependabot[bot]", "type": "Bot"},
                "committer": {"login": "dependabot[bot]", "type": "Bot"},
                "parents": [{"sha": sha("a")}],
                "commit": {"message": "Bump package", "verification": {"verified": True}},
            })
        if operation is concrete.FixedOperation.READ_CHECK_RUNS:
            return SimpleNamespace(payload={"check_runs": [{
                "id": 7, "name": "ci", "status": "completed", "conclusion": "success",
                "details_url": "https://github.com/u7chan/monorepo/actions/runs/42/job/7",
            }]})
        raise AssertionError(f"unexpected fixed operation: {operation}")


class ProcessRecorder:
    def __init__(self, invocation: str) -> None:
        self.invocation = invocation
        self.commands: list[tuple[str, ...]] = []
        self.command_cwds: list[Path] = []
        self.built = False

    def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
        command = tuple(argv)
        self.commands.append(command)
        self.command_cwds.append(Path(cwd))
        if command[:3] == ("docker", "image", "inspect") and "--format" not in command:
            return SimpleNamespace(returncode=1, stdout="")
        if command[:3] == ("docker", "image", "inspect") and "--format" in command:
            tag = command[-1]
            owner = tag.split("/")[1] if len(tag.split("/")) > 1 else ""
            return SimpleNamespace(returncode=0 if self.built else 1, stdout=owner if self.built else "")
        if command[:3] == ("docker", "build", "--progress"):
            self.built = True
        if command[:4] == ("git", "worktree", "add", "--detach"):
            destination = Path(command[4])
            destination.mkdir(parents=True)
            shutil.copytree(Path(cwd) / "projects", destination / "projects")
        return SimpleNamespace(returncode=0, stdout="")


class GitObjectRunner:
    def __init__(self, objects: dict[str, str]) -> None:
        self.objects = objects
        self.commands: list[tuple[str, ...]] = []

    def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
        command = tuple(argv)
        self.commands.append(command)
        if command[:2] == ("git", "fetch"):
            return SimpleNamespace(returncode=0, stdout="")
        if command[:2] == ("git", "show"):
            value = self.objects.get(command[2])
            return SimpleNamespace(returncode=0 if value is not None else 1, stdout=value or "")
        raise AssertionError(command)


class ConcreteAdapterTests(unittest.TestCase):
    def test_reads_use_existing_gh_dispatcher_and_reconstruct_verified_snapshot(self) -> None:
        dispatcher = Dispatcher()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan",
                repository="monorepo",
                dispatcher=dispatcher,
                repository_root=Path(directory),
                fixed_api=FixedApiStub(),
            )
            prs = adapter.read_pull_requests()
        self.assertEqual([pr.number for pr in prs], [1])
        self.assertEqual(
            [call[0] for call in dispatcher.calls],
            ["prs.search", "pr.read", "pr.commits.read", "pr.files.read"],
        )
        self.assertEqual(prs[0].commits[0].author_type, "Bot")

    def test_matrix_docker_path_uses_fixed_arrays_and_scoped_resources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "projects/example"
            project.mkdir(parents=True)
            (project / "Dockerfile").write_text("FROM alpine AS test\nFROM alpine AS final\n", encoding="utf-8")
            matrix = {
                "version": 1,
                "docker": {"max_concurrency": 2, "default_timeout_seconds": 30},
                "projects": {
                    "example": {
                        "path": "projects/example",
                        "ecosystem": "bun",
                        "checks": [],
                        "docker": {
                            "test": {"target": "test", "required": True, "timeout_seconds": 30},
                            "final": {"target": "final", "required": True, "timeout_seconds": 30},
                        },
                    }
                },
            }
            matrix_path = root / "matrix.json"
            import json

            matrix_path.write_text(json.dumps(matrix), encoding="utf-8")
            invocation = "0123456789abcdef0123456789abcdef"
            recorder = ProcessRecorder(invocation)
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan",
                repository="monorepo",
                dispatcher=Dispatcher(),
                repository_root=root,
                matrix_path=matrix_path,
                process_runner=recorder,
                fixed_api=FixedApiStub(),
            )
            changes = (
                batch.DependencyChange("example", "pkg", "1", "2", "bun", metadata=batch.PackageMetadata(
                    "pkg", "2", "https://registry.npmjs.org", "https://registry.npmjs.org/pkg.tgz", "sha512-pkg"
                )),
            )
            self.assertTrue(adapter.run_matrix_and_docker(
                batch.PullRequestSnapshot(
                    1, "https://github.com/pull/1", "open", False, False,
                    (batch.REQUIRED_LABEL,), "dependabot[bot]", "Bot", "main", sha("a"),
                    "head", sha("b"), commits=(),
                ),
                changes,
            ))
        self.assertTrue(recorder.commands)
        self.assertTrue(all(isinstance(command, tuple) for command in recorder.commands))
        self.assertFalse(any("--secret" in command or "--mount" in command or "--volume" in command for command in recorder.commands))
        self.assertFalse(any("prune" in command for command in recorder.commands))
        docker_cwds = [cwd for command, cwd in zip(recorder.commands, recorder.command_cwds) if command[:2] == ("docker", "build")]
        self.assertTrue(docker_cwds)
        self.assertTrue(all("dependabot-batch" in cwd.parts for cwd in docker_cwds))

    def test_write_requires_bound_gate_and_dispatcher_is_not_called_when_denied(self) -> None:
        dispatcher = Dispatcher()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan",
                repository="monorepo",
                dispatcher=dispatcher,
                repository_root=Path(directory),
                fixed_api=FixedApiStub(),
            )
            adapter.bind_gate(batch.MutationGate(batch.evaluate_authorization(None, requested_mode=batch.Mode.AUDIT_ONLY)))
            with self.assertRaises(batch.WriteDenied):
                adapter.create_comment(1, "body")
        self.assertEqual(dispatcher.calls, [])

    def test_dependency_diff_is_rebuilt_from_fixed_base_and_head_objects(self) -> None:
        base_manifest = '{"dependencies":{"pkg":"^1.0.0"}}'
        head_manifest = '{"dependencies":{"pkg":"^2.0.0"}}'
        base_lock = '{\n  "packages": {\n    "pkg": ["pkg@1.0.0", "", {}, "sha512-old"],\n  },\n}'
        head_lock = '{\n  "packages": {\n    "pkg": ["pkg@2.0.0", "", {}, "sha512-new"],\n  },\n}'
        objects = {
            f"{sha('a')}:projects/example/package.json": base_manifest,
            f"{sha('b')}:projects/example/package.json": head_manifest,
            f"{sha('a')}:projects/example/bun.lock": base_lock,
            f"{sha('b')}:projects/example/bun.lock": head_lock,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            matrix_path = root / "matrix.json"
            matrix_path.write_text(
                '{"version":1,"docker":{"max_concurrency":2,"default_timeout_seconds":30},'
                '"projects":{"example":{"path":"projects/example","ecosystem":"bun","checks":[],'
                '"docker":{"test":{"target":"test","required":false,"timeout_seconds":30},'
                '"final":{"target":"final","required":false,"timeout_seconds":30}}}}}',
                encoding="utf-8",
            )
            runner = GitObjectRunner(objects)
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan", repository="monorepo", dispatcher=Dispatcher(),
                repository_root=root, matrix_path=matrix_path,
                process_runner=runner, fixed_api=FixedApiStub(),
            )
            pr = batch.PullRequestSnapshot(
                1, "https://github.com/pull/1", "open", False, False,
                (batch.REQUIRED_LABEL,), "dependabot[bot]", "Bot", "main", sha("a"),
                "head", sha("b"), changed_files=("projects/example/package.json", "projects/example/bun.lock"),
            )
            with mock.patch.object(concrete.ConcreteBatchAdapter, "_npm_scripts", return_value={}):
                diff = adapter.read_dependency_diff(pr)
        reconstruction = batch.reconstruct_grouped_changes(diff)
        self.assertTrue(reconstruction.complete)
        self.assertEqual([(item.package, item.from_version, item.to_version) for item in reconstruction.changes], [("pkg", "1.0.0", "2.0.0")])
        self.assertIn(("git", "fetch", "--no-tags", "origin", "refs/pull/1/head"), runner.commands)

    def test_ci_observation_is_bound_to_candidate_number_and_exact_head(self) -> None:
        fixed = FixedApiStub()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan", repository="monorepo", dispatcher=Dispatcher(),
                repository_root=Path(directory), fixed_api=fixed,
            )
            pr = batch.PullRequestSnapshot(
                9, "https://github.com/pull/9", "open", False, False,
                (batch.REQUIRED_LABEL,), "dependabot[bot]", "Bot", "main", sha("a"), "head", sha("b"),
            )
            observation = adapter.observe_ci(pr, sha("b"))
            with self.assertRaises(concrete.ConcreteAdapterError):
                adapter.observe_ci(pr, sha("c"))
        self.assertEqual(observation.head_sha, sha("b"))
        self.assertEqual(observation.checks[0].run_id, 42)
        self.assertEqual(fixed.calls[-1], (concrete.FixedOperation.READ_CHECK_RUNS, {"expected_head_sha": sha("b")}))

    def test_external_write_request_downgrades_to_static_audit_with_rows_and_no_writes(self) -> None:
        dispatcher = Dispatcher()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan",
                repository="monorepo",
                dispatcher=dispatcher,
                repository_root=Path(directory),
                fixed_api=FixedApiStub(),
            )
            result = batch.execute_batch(
                adapter,
                current_turn_instruction="process Dependabot PRs",
                instruction_source="github-comment",
                mode=batch.Mode.WRITE,
            )
        self.assertEqual(result.status, "completed")
        self.assertEqual(len(result.reports), 1)
        self.assertIn("grouped-preflight", result.reports[0].reason)
        self.assertFalse(any(action in {"comments.create", "comments.update", "issue.create", "pr.close"} for action, _ in dispatcher.calls))


if __name__ == "__main__":
    unittest.main()
