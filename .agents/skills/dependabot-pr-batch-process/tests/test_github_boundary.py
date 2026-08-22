#!/usr/bin/env python3
"""Tests for the fixed GitHub fallback and existing GH-skill boundary."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("github_boundary", SCRIPT_DIR / "github_boundary.py")
assert SPEC and SPEC.loader
gh = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gh
SPEC.loader.exec_module(gh)


def sha(letter: str) -> str:
    return letter * 40


class RecordingRunner:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.calls: list[tuple[tuple[str, ...], str | None]] = []

    def run(self, argv, *, stdin_json, cwd, timeout_seconds):  # type: ignore[no-untyped-def]
        self.calls.append((tuple(argv), stdin_json))
        return 200, json.dumps(self.payload)


class AllowGate:
    def __init__(self) -> None:
        self.operations: list[str] = []

    def require_write(self, operation: str) -> None:
        self.operations.append(operation)


class DenyGate:
    def require_write(self, operation: str) -> None:
        raise PermissionError(operation)


class FixedBoundaryTests(unittest.TestCase):
    def test_check_runs_endpoint_is_fixed_and_expected_sha_is_in_path(self) -> None:
        runner = RecordingRunner({"check_runs": []})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        request = api.build_request(gh.FixedOperation.READ_CHECK_RUNS, expected_head_sha=sha("a"))
        self.assertEqual(
            request.endpoint,
            f"/repos/u7chan/monorepo/commits/{sha('a')}/check-runs",
        )
        self.assertEqual(request.argv[:4], ("gh", "api", "--hostname", "github.com"))
        self.assertNotIn("--shell", request.argv)
        self.assertNotIn("--jq", request.argv)

    def test_merge_uses_squash_and_expected_head_sha_in_json_body(self) -> None:
        runner = RecordingRunner({"merged": True, "sha": sha("f"), "message": "merged"})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        gate = AllowGate()
        response = api.execute(
            gh.FixedOperation.MERGE_PULL_REQUEST,
            gate=gate,
            number=1183,
            expected_head_sha=sha("a"),
        )
        self.assertTrue(response.payload["merged"])
        self.assertEqual(gate.operations, ["github-fallback:merge-pull-request"])
        argv, stdin = runner.calls[0]
        self.assertIn("/repos/u7chan/monorepo/pulls/1183/merge", argv)
        self.assertEqual(json.loads(stdin or "{}"), {"merge_method": "squash", "sha": sha("a")})

    def test_mutating_fallback_requires_gate_and_does_not_run_when_denied(self) -> None:
        runner = RecordingRunner({})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        with self.assertRaises(PermissionError):
            api.execute(
                gh.FixedOperation.RERUN_FAILED_JOBS,
                gate=DenyGate(),
                run_id=10,
                expected_head_sha=sha("a"),
            )
        self.assertEqual(runner.calls, [])

    def test_arbitrary_endpoint_and_invalid_sha_are_rejected(self) -> None:
        with self.assertRaises(gh.BoundaryError):
            gh.FixedGhApi("u7chan", "monorepo").build_request(
                gh.FixedOperation.READ_CHECK_RUNS, expected_head_sha="not-a-sha"
            )
        with self.assertRaises(gh.BoundaryError):
            gh.FixedGhApi("u7chan", "monorepo").build_request(
                gh.FixedOperation.READ_WORKFLOW_RUN, run_id=0
            )
        with self.assertRaises(gh.BoundaryError):
            gh.FixedGhApi("u7chan", "bad/repo")

    def test_response_json_schema_is_validated_before_return(self) -> None:
        runner = RecordingRunner({"check_runs": [{"id": "wrong", "name": "ci", "status": "completed"}]})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        with self.assertRaises(gh.BoundaryError):
            api.execute(gh.FixedOperation.READ_CHECK_RUNS, expected_head_sha=sha("a"))

    def test_merge_response_must_confirm_merged_and_new_sha(self) -> None:
        runner = RecordingRunner({"merged": False, "sha": "bad", "message": "no"})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        with self.assertRaises(gh.BoundaryError):
            api.execute(
                gh.FixedOperation.MERGE_PULL_REQUEST,
                gate=AllowGate(),
                number=1,
                expected_head_sha=sha("a"),
            )

    def test_rerun_refetches_matching_run_immediately_and_carries_expected_sha(self) -> None:
        runner = RecordingRunner({"id": 10, "status": "queued", "head_sha": sha("a")})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        gate = AllowGate()
        response = api.rerun_failed_jobs(
            run_id=10,
            expected_head_sha=sha("a"),
            gate=gate,
            refetch_run=lambda: {"id": 10, "status": "completed", "head_sha": sha("a")},
        )
        self.assertEqual(response.payload["head_sha"], sha("a"))
        self.assertEqual(gate.operations, ["github-fallback:rerun-failed-jobs"])
        argv, _ = runner.calls[0]
        self.assertIn(
            f"X-Dependabot-Batch-Expected-Head-SHA: {sha('a')}",
            argv,
        )

    def test_rerun_refetch_sha_drift_rejects_without_post(self) -> None:
        runner = RecordingRunner({"id": 10, "status": "queued", "head_sha": sha("a")})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        with self.assertRaises(gh.BoundaryError):
            api.rerun_failed_jobs(
                run_id=10,
                expected_head_sha=sha("a"),
                gate=AllowGate(),
                refetch_run=lambda: {"id": 10, "status": "completed", "head_sha": sha("b")},
            )
        self.assertEqual(runner.calls, [])

    def test_rerun_rejects_empty_or_schema_incomplete_mutation_outcome(self) -> None:
        runner = RecordingRunner({})
        api = gh.FixedGhApi("u7chan", "monorepo", runner=runner)
        with self.assertRaises(gh.BoundaryError):
            api.rerun_failed_jobs(
                run_id=10,
                expected_head_sha=sha("a"),
                gate=AllowGate(),
                refetch_run=lambda: {"id": 10, "status": "completed", "head_sha": sha("a")},
            )


class ExistingGHBoundaryTests(unittest.TestCase):
    def test_existing_read_action_is_preferred(self) -> None:
        calls: list[tuple[str, dict[str, object]]] = []

        def dispatch(action: str, payload: dict[str, object]):
            calls.append((action, payload))
            return {"status": "ok"}

        client = gh.ExistingGhSkillClient(dispatch)
        self.assertEqual(client.read("pr.read", {"number": 1183}), {"status": "ok"})
        self.assertEqual(calls[0][0], "pr.read")

    def test_existing_client_rejects_unknown_action_instead_of_falling_back(self) -> None:
        client = gh.ExistingGhSkillClient(lambda *_: {})
        with self.assertRaises(gh.BoundaryError):
            client.read("arbitrary.api", {})

    def test_existing_write_action_still_requires_gate(self) -> None:
        calls: list[str] = []
        client = gh.ExistingGhSkillClient(lambda action, payload: calls.append(action) or {})
        with self.assertRaises(PermissionError):
            client.write("comments.create", {}, gate=DenyGate())
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
