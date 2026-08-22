#!/usr/bin/env python3
"""Contract tests for the concrete GH/process adapter with no live calls."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


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


class ProcessRecorder:
    def __init__(self, invocation: str) -> None:
        self.invocation = invocation
        self.commands: list[tuple[str, ...]] = []
        self.built = False

    def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
        command = tuple(argv)
        self.commands.append(command)
        if command[:3] == ("docker", "image", "inspect") and "--format" not in command:
            return SimpleNamespace(returncode=1, stdout="")
        if command[:3] == ("docker", "image", "inspect") and "--format" in command:
            tag = command[-1]
            owner = tag.split("/")[1] if len(tag.split("/")) > 1 else ""
            return SimpleNamespace(returncode=0 if self.built else 1, stdout=owner if self.built else "")
        if command[:3] == ("docker", "build", "--progress"):
            self.built = True
        return SimpleNamespace(returncode=0, stdout="")


class ConcreteAdapterTests(unittest.TestCase):
    def test_reads_use_existing_gh_dispatcher_and_reconstruct_verified_snapshot(self) -> None:
        dispatcher = Dispatcher()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan",
                repository="monorepo",
                dispatcher=dispatcher,
                repository_root=Path(directory),
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

    def test_write_requires_bound_gate_and_dispatcher_is_not_called_when_denied(self) -> None:
        dispatcher = Dispatcher()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan", repository="monorepo", dispatcher=dispatcher, repository_root=Path(directory)
            )
            adapter.bind_gate(batch.MutationGate(batch.evaluate_authorization(None, requested_mode=batch.Mode.AUDIT_ONLY)))
            with self.assertRaises(batch.WriteDenied):
                adapter.create_comment(1, "body")
        self.assertEqual(dispatcher.calls, [])

    def test_external_write_request_downgrades_to_static_audit_with_rows_and_no_writes(self) -> None:
        dispatcher = Dispatcher()
        with tempfile.TemporaryDirectory() as directory:
            adapter = concrete.ConcreteBatchAdapter(
                owner="u7chan", repository="monorepo", dispatcher=dispatcher, repository_root=Path(directory)
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
