#!/usr/bin/env python3
"""Concrete GH/process adapter for the Dependabot batch state machine.

The adapter deliberately has no generic API or shell escape hatch.  Supported
reads/writes go through the repository GH dispatcher; workflow rerun, branch
update, merge, and run inspection use the fixed boundary.  Process and Docker
commands are argument arrays executed by ``SecureProcessRunner``.
"""

from __future__ import annotations

import functools
import json
import re
import subprocess
import tempfile
import time
import tomllib
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Mapping

from batch_process import (
    DEFAULT_BRANCH,
    REQUIRED_LABEL,
    CheckObservation,
    CIObservation,
    CommentRecord,
    DockerBatchRunner,
    DockerResourceCleaner,
    DependencyChange,
    FootprintedItem,
    FixCommit,
    IssueRecord,
    LifecycleScriptEvidence,
    ManifestLockDiff,
    MatrixCheckRunner,
    MutationGate,
    PackageMetadata,
    PullRequestSnapshot,
    RepairCommitRecord,
    RepairDiagnosis,
    RepairProvenanceRecord,
    SHA_RE,
    SecureProcessRunner,
    VerificationMatrix,
    build_repair_provenance_body,
    docker_specs_for_project,
    footprint_for_paths,
    make_repair_provenance_marker,
    parse_repair_provenance_record,
    verification_passed,
)
from github_boundary import FixedGhApi, FixedOperation, ExistingGhSkillClient


class ConcreteAdapterError(RuntimeError):
    """The concrete boundary returned incomplete or unsafe state."""


class GhSkillProcessDispatcher:
    """Invoke the repository GH skill with a fixed argv and JSON request file."""

    def __init__(self, script: Path, *, cwd: Path, timeout_seconds: int = 120) -> None:
        self.script = script.resolve()
        self.cwd = cwd.resolve()
        self.timeout_seconds = timeout_seconds

    def __call__(self, action: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        if not isinstance(action, str) or not action or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for char in action):
            raise ConcreteAdapterError("unsafe GH action name")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=True) as request:
            json.dump(payload, request, ensure_ascii=False)
            request.flush()
            completed = subprocess.run(
                (str(self.script), action, request.name),
                cwd=self.cwd,
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        if completed.returncode != 0:
            raise ConcreteAdapterError(f"GH skill action failed: {action}")
        try:
            response = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ConcreteAdapterError("GH skill returned non-JSON output") from exc
        if not isinstance(response, Mapping):
            raise ConcreteAdapterError("GH skill response is not an object")
        return response


def _data(response: Mapping[str, Any]) -> Any:
    if response.get("status") not in {None, "ok", "already_applied"}:
        raise ConcreteAdapterError("GH dispatcher returned a failed envelope")
    if "data" not in response:
        raise ConcreteAdapterError("GH dispatcher response lacks data")
    return response["data"]


class ConcreteBatchAdapter:
    """A non-generic adapter implementing the full :class:`BatchAdapter` boundary."""

    def __init__(
        self,
        *,
        owner: str,
        repository: str,
        dispatcher: Any,
        repository_root: Path,
        matrix_path: Path | None = None,
        process_runner: Any | None = None,
        fixed_api: FixedGhApi | None = None,
    ) -> None:
        self.gh = ExistingGhSkillClient(dispatcher)
        self.fixed = fixed_api or FixedGhApi(owner, repository, cwd=repository_root)
        self.repository_root = repository_root.resolve()
        self.matrix_path = matrix_path or (
            repository_root / ".agents/skills/dependabot-pr-batch-process/verification-matrix.json"
        )
        self.process_runner = process_runner or SecureProcessRunner()
        self._gate: MutationGate | None = None
        self._check_urls: dict[int, tuple[str, ...]] = {}
        self._run_ids: dict[int, tuple[int, ...]] = {}

    def bind_gate(self, gate: MutationGate) -> None:
        self._gate = gate

    def _gate_write(self, operation: str) -> MutationGate:
        if self._gate is None:
            raise ConcreteAdapterError("adapter is not bound to a MutationGate")
        self._gate.require_write(operation)
        return self._gate

    def _read_pr_mapping(self, number: int) -> Mapping[str, Any]:
        data = _data(self.gh.read("pr.read", {"number": number}))
        if not isinstance(data, Mapping):
            raise ConcreteAdapterError("pr.read did not return an object")
        return data

    def _snapshot(self, number: int, raw: Mapping[str, Any] | None = None) -> PullRequestSnapshot:
        pr = dict(raw or self._read_pr_mapping(number))
        commits_data = _data(self.gh.read("pr.commits.read", {"number": number}))
        files_data = _data(self.gh.read("pr.files.read", {"number": number}))
        commits = commits_data if isinstance(commits_data, list) else (
            commits_data.get("items", []) if isinstance(commits_data, Mapping) else []
        )
        # pr.commits.read intentionally exposes only a reduced shape.  Trust
        # decisions require GitHub's actor type and signature verification,
        # so enrich every fixed SHA through the non-generic commit boundary.
        enriched_commits: list[Mapping[str, Any]] = []
        for item in commits:
            if not isinstance(item, Mapping) or not isinstance(item.get("sha"), str):
                raise ConcreteAdapterError("commit list contains an incomplete entry")
            response = self.fixed.execute(FixedOperation.READ_COMMIT, commit_sha=item["sha"])
            enriched_commits.append(response.payload)
        files = files_data if isinstance(files_data, list) else (
            files_data.get("items", []) if isinstance(files_data, Mapping) else []
        )
        pr["commits"] = enriched_commits
        pr["files"] = [item.get("filename") for item in files if isinstance(item, Mapping)]
        return PullRequestSnapshot.from_mapping(pr, default_branch=DEFAULT_BRANCH)

    def read_pull_requests(self) -> tuple[PullRequestSnapshot, ...]:
        data = _data(
            self.gh.read(
                "prs.search",
                {"q": f"is:open label:{REQUIRED_LABEL}", "per_page": 100},
            )
        )
        items = data.get("items", []) if isinstance(data, Mapping) else data
        if not isinstance(items, list):
            raise ConcreteAdapterError("prs.search did not return an item list")
        return tuple(
            self._snapshot(int(item["number"]))
            for item in items
            if isinstance(item, Mapping) and isinstance(item.get("number"), int)
        )

    def read_current_pr(self, number: int) -> PullRequestSnapshot:
        return self._snapshot(number)

    def read_repair_provenance(self, pr: PullRequestSnapshot) -> tuple[RepairProvenanceRecord, ...]:
        data = _data(self.gh.read("comments.read", {"number": pr.number, "per_page": 100}))
        items = data.get("items", []) if isinstance(data, Mapping) else []
        result: list[RepairProvenanceRecord] = []
        for item in items:
            if not isinstance(item, Mapping) or not isinstance(item.get("id"), int) or not isinstance(item.get("body"), str):
                continue
            authoritative = self.fixed.execute(
                FixedOperation.READ_ISSUE_COMMENT,
                comment_id=item["id"],
            ).payload
            user = authoritative.get("user")
            parsed = parse_repair_provenance_record(
                item["id"],
                authoritative.get("body", ""),
                source_author_login=user.get("login") if isinstance(user, Mapping) else None,
                source_author_type=user.get("type") if isinstance(user, Mapping) else None,
            )
            if parsed and parsed.pr_number == pr.number:
                result.append(parsed)
        return tuple(result)

    def read_repair_chain(self, pr: PullRequestSnapshot) -> tuple[RepairCommitRecord, ...]:
        provenance = self.read_repair_provenance(pr)
        result: list[RepairCommitRecord] = []
        for commit in pr.commits:
            marker = commit.trailers.get("Dependabot-Batch-Fix")
            if not marker or not SHA_RE.fullmatch(commit.sha):
                continue
            matching = next(
                (
                    item
                    for item in provenance
                    if item.commit_sha == commit.sha
                    and item.actor == (commit.author_login or "")
                    and item.parent_sha in commit.parents
                    and item.marker == make_repair_provenance_marker(
                        pr.number,
                        item.run_id,
                        item.parent_sha,
                        commit.sha,
                    )
                ),
                None,
            )
            if matching is None:
                continue
            result.append(
                RepairCommitRecord(
                    pr.number,
                    matching.run_id,
                    matching.parent_sha,
                    commit.sha,
                    marker,
                    commit.author_login or "",
                    commit.committer_login or "",
                    commit.verification_verified,
                    matching.marker,
                )
            )
        return tuple(result)

    @staticmethod
    def _diff_from_mapping(value: Mapping[str, Any]) -> ManifestLockDiff:
        def string_map(key: str) -> dict[str, str]:
            raw = value.get(key, {})
            if not isinstance(raw, Mapping) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in raw.items()):
                raise ConcreteAdapterError(f"dependency diff {key} is not a string map")
            return dict(raw)

        raw_metadata = value.get("metadata", {})
        if not isinstance(raw_metadata, Mapping):
            raise ConcreteAdapterError("dependency diff metadata is not an object")
        metadata = {
            str(name): PackageMetadata.from_mapping(item)
            for name, item in raw_metadata.items()
            if isinstance(name, str) and isinstance(item, Mapping)
        }
        raw_scripts = value.get("script_changes", {})
        script_changes = raw_scripts if isinstance(raw_scripts, Mapping) else {}
        raw_lifecycle = value.get("lifecycle_scripts", {})
        lifecycle: dict[str, LifecycleScriptEvidence] = {}
        if isinstance(raw_lifecycle, Mapping):
            for name, item in raw_lifecycle.items():
                if isinstance(name, str) and isinstance(item, Mapping):
                    lifecycle[name] = LifecycleScriptEvidence(
                        string_map_from(item, "before"),
                        string_map_from(item, "after"),
                    )
        return ManifestLockDiff(
            str(value.get("project") or ""),
            str(value.get("ecosystem") or ""),
            string_map("manifest_before"),
            string_map("manifest_after"),
            string_map("lock_before"),
            string_map("lock_after"),
            metadata,
            {str(k): dict(v) for k, v in script_changes.items() if isinstance(k, str) and isinstance(v, Mapping)},
            {str(k): str(v) for k, v in (value.get("source_types", {}) or {}).items()},
            lifecycle,
        )

    def _fetch_pr_head(self, pr: PullRequestSnapshot) -> None:
        completed = self.process_runner.run(
            ("git", "fetch", "--no-tags", "origin", f"refs/pull/{pr.number}/head"),
            cwd=self.repository_root,
            timeout_seconds=120,
        )
        if getattr(completed, "returncode", None) != 0:
            raise ConcreteAdapterError("failed to fetch fixed pull request head")

    def _read_at(self, sha: str, path: str) -> str:
        if not SHA_RE.fullmatch(sha) or path.startswith("/") or ".." in Path(path).parts:
            raise ConcreteAdapterError("unsafe git object read")
        completed = self.process_runner.run(
            ("git", "show", f"{sha}:{path}"),
            cwd=self.repository_root,
            timeout_seconds=60,
        )
        if getattr(completed, "returncode", None) != 0:
            raise ConcreteAdapterError(f"required dependency file is unavailable: {path}")
        return str(getattr(completed, "stdout", ""))

    @staticmethod
    def _bun_lock(text: str) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
        versions: dict[str, str] = {}
        artifacts: dict[str, tuple[str, str]] = {}
        pattern = re.compile(
            r'^\s*"(?P<key>(?:[^"\\]|\\.)+)"\s*:\s*\["(?P<resolved>(?:[^"\\]|\\.)+)"\s*,\s*"(?P<url>[^"]*)".*?,\s*"(?P<integrity>sha(?:256|384|512)-[^"]+)"\s*\],?\s*$',
            re.MULTILINE,
        )
        for match in pattern.finditer(text):
            resolved = match.group("resolved")
            if "@" not in resolved:
                continue
            package, version = resolved.rsplit("@", 1)
            if not package or not version:
                continue
            versions[package] = version
            artifacts[package] = (match.group("url"), match.group("integrity"))
        return versions, artifacts

    @staticmethod
    @functools.lru_cache(maxsize=1024)
    def _npm_scripts(package: str, version: str) -> Mapping[str, str]:
        if not re.fullmatch(r"(?:@[a-z0-9._~-]+/)?[a-z0-9._~-]+", package) or not re.fullmatch(r"[0-9A-Za-z.+_-]+", version):
            raise ConcreteAdapterError("unsafe npm package identity")
        encoded = urllib.parse.quote(package, safe="@")
        request = urllib.request.Request(
            f"https://registry.npmjs.org/{encoded}/{urllib.parse.quote(version, safe='')}",
            headers={"Accept": "application/json", "User-Agent": "dependabot-batch-preflight/1"},
        )
        last_error: Exception | None = None
        payload: Any = None
        for _ in range(3):
            try:
                with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 - fixed registry host
                    payload = json.loads(response.read(2_000_000))
                break
            except Exception as exc:
                last_error = exc
        else:
            raise ConcreteAdapterError("npm lifecycle metadata unavailable") from last_error
        scripts = payload.get("scripts") if isinstance(payload, Mapping) else None
        if scripts is None:
            return {}
        if not isinstance(scripts, Mapping) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in scripts.items()):
            raise ConcreteAdapterError("npm lifecycle metadata is malformed")
        lifecycle_names = {"preinstall", "install", "postinstall", "preuninstall", "uninstall", "postuninstall"}
        return {key: value for key, value in scripts.items() if key in lifecycle_names}

    def _read_bun_diff(self, pr: PullRequestSnapshot, project: str) -> ManifestLockDiff:
        root = f"projects/{project}"
        before_manifest = json.loads(self._read_at(pr.base_sha, f"{root}/package.json"))
        after_manifest = json.loads(self._read_at(pr.head_sha, f"{root}/package.json"))
        before_lock, before_artifacts = self._bun_lock(self._read_at(pr.base_sha, f"{root}/bun.lock"))
        after_lock, after_artifacts = self._bun_lock(self._read_at(pr.head_sha, f"{root}/bun.lock"))
        def direct_names(value: Mapping[str, Any]) -> set[str]:
            return {
                str(name)
                for key in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
                for name in (value.get(key, {}) if isinstance(value.get(key), Mapping) else {})
            }
        before_direct = direct_names(before_manifest)
        after_direct = direct_names(after_manifest)
        changed = {name for name in set(before_lock) | set(after_lock) if before_lock.get(name) != after_lock.get(name)}
        metadata: dict[str, PackageMetadata] = {}
        lifecycle: dict[str, LifecycleScriptEvidence] = {}
        script_changes: dict[str, Mapping[str, str]] = {}
        for name in changed:
            selected_version = after_lock.get(name) or before_lock.get(name)
            _, integrity = (after_artifacts.get(name) or before_artifacts.get(name) or ("", ""))
            scripts_after = self._npm_scripts(name, selected_version or "") if after_lock.get(name) else {}
            scripts_before = self._npm_scripts(name, before_lock[name]) if before_lock.get(name) else {}
            metadata[name] = PackageMetadata(
                name,
                selected_version or "",
                "https://registry.npmjs.org",
                f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@')}/-/{name.rsplit('/', 1)[-1]}-{selected_version}.tgz",
                integrity or None,
                lifecycle_scripts=scripts_after,
                lifecycle_scripts_known=True,
            )
            lifecycle[name] = LifecycleScriptEvidence(scripts_before, scripts_after)
            changed_scripts = {key: value for key, value in scripts_after.items() if scripts_before.get(key) != value}
            if changed_scripts:
                script_changes[name] = changed_scripts
        return ManifestLockDiff(
            project,
            "bun",
            {name: before_lock[name] for name in before_direct if name in before_lock},
            {name: after_lock[name] for name in after_direct if name in after_lock},
            before_lock,
            after_lock,
            metadata,
            script_changes,
            lifecycle_scripts=lifecycle,
        )

    def _read_uv_diff(self, pr: PullRequestSnapshot, project: str) -> ManifestLockDiff:
        root = f"projects/{project}"
        before = tomllib.loads(self._read_at(pr.base_sha, f"{root}/uv.lock"))
        after = tomllib.loads(self._read_at(pr.head_sha, f"{root}/uv.lock"))
        def packages(value: Mapping[str, Any]) -> tuple[dict[str, str], dict[str, PackageMetadata]]:
            versions: dict[str, str] = {}
            metadata: dict[str, PackageMetadata] = {}
            for item in value.get("package", []):
                if not isinstance(item, Mapping) or not isinstance(item.get("name"), str) or not isinstance(item.get("version"), str):
                    continue
                name, version = item["name"], item["version"]
                artifact = item.get("sdist")
                if not isinstance(artifact, Mapping):
                    wheels = item.get("wheels")
                    artifact = wheels[0] if isinstance(wheels, list) and wheels and isinstance(wheels[0], Mapping) else {}
                url, digest = artifact.get("url"), artifact.get("hash")
                source = item.get("source") if isinstance(item.get("source"), Mapping) else {}
                registry = source.get("registry")
                versions[name] = version
                metadata[name] = PackageMetadata(
                    name, version, str(registry or ""), str(url or ""), str(digest) if digest else None,
                    lifecycle_scripts={}, lifecycle_scripts_known=True,
                )
            return versions, metadata
        before_versions, _ = packages(before)
        after_versions, after_metadata = packages(after)
        _, before_metadata = packages(before)
        changed = {name for name in set(before_versions) | set(after_versions) if before_versions.get(name) != after_versions.get(name)}
        metadata = {name: after_metadata.get(name) or before_metadata[name] for name in changed}
        # uv projects have no npm-style install lifecycle scripts.
        lifecycle = {name: LifecycleScriptEvidence({}, {}) for name in changed}
        return ManifestLockDiff(project, "uv", {}, {}, before_versions, after_versions, metadata, lifecycle_scripts=lifecycle)

    def read_dependency_diff(self, pr: PullRequestSnapshot) -> ManifestLockDiff:
        self._fetch_pr_head(pr)
        projects = {
            parts[1]
            for path in pr.changed_files
            if len(parts := Path(path).parts) >= 3
            and parts[0] == "projects"
            and parts[2] in {"package.json", "bun.lock", "pyproject.toml", "uv.lock"}
        }
        if len(projects) != 1:
            raise ConcreteAdapterError("dependency diff must belong to exactly one project")
        project = next(iter(projects))
        raw_matrix = json.loads(self.matrix_path.read_text(encoding="utf-8"))
        matrix = VerificationMatrix.from_mapping(raw_matrix)
        definition = matrix.projects.get(project)
        if definition is None:
            raise ConcreteAdapterError("dependency project is absent from verification matrix")
        return self._read_bun_diff(pr, project) if definition.ecosystem == "bun" else self._read_uv_diff(pr, project)

    def footprint(self, pr: PullRequestSnapshot, diff: ManifestLockDiff) -> FootprintedItem:
        return FootprintedItem(pr.number, footprint_for_paths(pr.changed_files))

    def run_matrix_and_docker(self, pr: PullRequestSnapshot, changes: tuple[DependencyChange, ...]) -> bool:
        if not changes:
            return False
        project = changes[0].project
        raw = json.loads(self.matrix_path.read_text(encoding="utf-8"))
        matrix = VerificationMatrix.from_mapping(raw)
        definition = matrix.projects.get(project)
        if definition is None:
            return False
        worktree, docker = self.create_scoped_worktree(pr.number, pr.head_sha)
        try:
            checks = MatrixCheckRunner(self.process_runner, worktree).run_project(definition)
            if not verification_passed(checks):
                return False
            specs = docker_specs_for_project(
                matrix,
                project,
                repository_root=worktree,
                commit_sha=pr.head_sha,
                invocation_id=docker.invocation_id,
            )
            docker_results = docker.run(specs)
            return all(result.status == "passed" for result in docker_results)
        finally:
            # docker.run normally performs this cleanup.  Matrix failures and
            # setup exceptions occur before it, so clean the owned path here.
            if worktree in docker.tracked_worktrees:
                try:
                    docker.cleaner.remove_worktree(worktree)
                except Exception:
                    pass
                docker.tracked_worktrees.discard(worktree)

    def create_scoped_worktree(self, pr_number: int, ref_sha: str) -> tuple[Path, DockerBatchRunner]:
        """Create a generated, run-owned detached worktree with fixed argv."""

        if not isinstance(pr_number, int) or pr_number < 1 or not SHA_RE.fullmatch(ref_sha):
            raise ConcreteAdapterError("invalid worktree ref SHA")
        fetched = self.process_runner.run(
            ("git", "fetch", "--no-tags", "origin", f"refs/pull/{pr_number}/head"),
            cwd=self.repository_root,
            timeout_seconds=120,
        )
        if getattr(fetched, "returncode", None) != 0:
            raise ConcreteAdapterError("failed to fetch fixed pull request head")
        invocation_id = uuid.uuid4().hex
        path = self.repository_root / ".git" / "dependabot-batch" / invocation_id
        docker = DockerBatchRunner(
            self.process_runner,
            DockerResourceCleaner(self.process_runner, self.repository_root),
            # Docker contexts and all matrix commands resolve inside the
            # candidate tree; the cleaner still removes the tree via the
            # original repository root.
            repository_root=path,
            invocation_id=invocation_id,
        )
        if not docker.track_worktree(path):
            raise ConcreteAdapterError("generated worktree path already exists")
        created = self.process_runner.run(
            ("git", "worktree", "add", "--detach", str(path), ref_sha),
            cwd=self.repository_root,
            timeout_seconds=120,
        )
        if getattr(created, "returncode", None) != 0:
            docker.tracked_worktrees.discard(path.resolve())
            raise ConcreteAdapterError("failed to create candidate worktree")
        return path, docker

    def observe_ci(self, pr: PullRequestSnapshot, expected_head_sha: str) -> CIObservation:
        if pr.head_sha.casefold() != expected_head_sha.casefold():
            raise ConcreteAdapterError("CI observation head does not match candidate")
        number = pr.number
        payload = self.fixed.execute(
            FixedOperation.READ_CHECK_RUNS,
            expected_head_sha=expected_head_sha,
        ).payload
        items = payload.get("check_runs")
        if not isinstance(items, list):
            raise ConcreteAdapterError("check-run response lacks items")
        checks: list[CheckObservation] = []
        run_ids: list[int] = []
        urls: list[str] = []
        for item in items:
            if not isinstance(item, Mapping):
                continue
            details_url = item.get("details_url") or item.get("html_url")
            run_id: int | None = item.get("run_id") if isinstance(item.get("run_id"), int) else None
            if run_id is None and isinstance(details_url, str):
                match = re.search(r"/actions/runs/(\d+)(?:/|$)", details_url)
                run_id = int(match.group(1)) if match else None
            checks.append(
                CheckObservation(
                    str(item.get("name") or "unknown"),
                    str(item.get("status") or "unknown"),
                    item.get("conclusion") if isinstance(item.get("conclusion"), str) else None,
                    details_url if isinstance(details_url, str) else None,
                    run_id,
                )
            )
            if run_id is not None:
                run_ids.append(run_id)
            if isinstance(details_url, str):
                urls.append(details_url)
        self._run_ids[number] = tuple(sorted(set(run_ids)))
        self._check_urls[number] = tuple(sorted(set(urls)))
        return CIObservation(expected_head_sha, tuple(checks))

    def rerun_ci(self, pr: PullRequestSnapshot, observation: CIObservation, expected_head_sha: str) -> None:
        run_id = observation.run_id
        if run_id is None:
            raise ConcreteAdapterError("transient check has no fixed workflow run ID")
        self.fixed.rerun_failed_jobs(
            run_id=run_id,
            expected_head_sha=expected_head_sha,
            gate=self._gate_write("rerun-ci"),
        )

    def repair_run_id(self, pr: PullRequestSnapshot) -> int:
        run_ids = self._run_ids.get(pr.number, ())
        return run_ids[0] if run_ids else 1

    def diagnose_repair(self, pr: PullRequestSnapshot, cycle: int, head_sha: str) -> RepairDiagnosis:
        return RepairDiagnosis(False, False, "no fixed repair patch adapter is available")

    def create_fix_commit(self, pr: PullRequestSnapshot, diagnosis: RepairDiagnosis, marker: str, message: str) -> FixCommit:
        raise ConcreteAdapterError("repair commit creation requires a reviewed fixed patch")

    def push_fix(self, pr: PullRequestSnapshot, expected_head_sha: str, commit: FixCommit) -> None:
        self._gate_write("push-fix")
        raise ConcreteAdapterError("no unreviewed arbitrary git push is permitted")

    def update_branch(self, number: int, expected_head_sha: str, expected_base_sha: str) -> PullRequestSnapshot:
        self.fixed.execute(
            FixedOperation.UPDATE_PULL_REQUEST_BRANCH,
            gate=self._gate_write("update-branch"),
            number=number,
            expected_head_sha=expected_head_sha,
        )
        updated = self.read_current_pr(number)
        if updated.head_sha.casefold() == expected_head_sha.casefold():
            raise ConcreteAdapterError("branch update did not produce a new head")
        if updated.base_sha.casefold() != expected_base_sha.casefold():
            raise ConcreteAdapterError("branch update refetch did not confirm expected base")
        return updated

    def rebuild_snapshot(self, pr: PullRequestSnapshot) -> PullRequestSnapshot:
        return self.read_current_pr(pr.number)

    def record_repair_provenance(self, pr: PullRequestSnapshot, record: RepairCommitRecord) -> RepairProvenanceRecord:
        body = build_repair_provenance_body(record)
        data = _data(
            self.gh.write(
                "comments.create",
                {"number": pr.number, "body": body},
                gate=self._gate_write("record-repair-provenance"),
            )
        )
        if not isinstance(data, Mapping) or not isinstance(data.get("id"), int) or not isinstance(data.get("body"), str):
            raise ConcreteAdapterError("provenance comment response is incomplete")
        parsed = parse_repair_provenance_record(data["id"], data["body"])
        if parsed is None:
            raise ConcreteAdapterError("provenance comment did not round-trip")
        fetched = next(
            (item for item in self.read_repair_provenance(pr) if item.record_id == parsed.record_id),
            None,
        )
        if fetched is None:
            raise ConcreteAdapterError("provenance comment was not visible in GitHub state")
        return fetched

    def ci_success_for_head(self, head_sha: str) -> bool:
        matching_pr = next(
            (pr for pr in self.read_pull_requests() if pr.head_sha.casefold() == head_sha.casefold()),
            None,
        )
        if matching_pr is None:
            return False
        observation = self.observe_ci(matching_pr, head_sha)
        return observation.head_sha == head_sha and bool(observation.checks) and all(
            item.conclusion == "success" for item in observation.checks
        )

    def merge_pr(self, number: int, expected_head_sha: str) -> str:
        data = self.fixed.execute(
            FixedOperation.MERGE_PULL_REQUEST,
            gate=self._gate_write("squash-merge"),
            number=number,
            expected_head_sha=expected_head_sha,
        ).payload
        if not isinstance(data.get("sha"), str):
            raise ConcreteAdapterError("merge response lacks SHA")
        return data["sha"]

    def wait_for_cd(self, merge_sha: str) -> bool:
        if not SHA_RE.fullmatch(merge_sha):
            return False
        deadline = time.monotonic() + 30 * 60
        while time.monotonic() < deadline:
            response = self.fixed.execute(
                FixedOperation.READ_CHECK_RUNS,
                expected_head_sha=merge_sha,
            )
            runs = response.payload.get("check_runs")
            if isinstance(runs, list) and runs and all(
                isinstance(item, Mapping)
                and item.get("status") == "completed"
                and item.get("conclusion") == "success"
                for item in runs
            ):
                return True
            time.sleep(min(60, max(0, deadline - time.monotonic())))
        return False

    def read_comments(self, number: int):
        data = _data(self.gh.read("comments.read", {"number": number, "per_page": 100}))
        items = data.get("items", []) if isinstance(data, Mapping) else []
        return tuple(
            CommentRecord(item["id"], item.get("body", ""), item.get("html_url", ""))
            for item in items
            if isinstance(item, Mapping) and isinstance(item.get("id"), int) and isinstance(item.get("body"), str)
        )

    def create_comment(self, number: int, body: str) -> CommentRecord:
        data = _data(self.gh.write("comments.create", {"number": number, "body": body}, gate=self._gate_write("comment-create")))
        return CommentRecord(int(data["id"]), str(data.get("body", body)), str(data.get("html_url", "")))

    def update_comment(self, comment_id: int, body: str) -> CommentRecord:
        data = _data(self.gh.write("comments.update", {"comment_id": comment_id, "body": body}, gate=self._gate_write("comment-update")))
        return CommentRecord(int(data["id"]), str(data.get("body", body)), str(data.get("html_url", "")))

    def read_followup_issues(self):
        data = _data(self.gh.read("issue.list", {"per_page": 100}))
        items = data.get("items", []) if isinstance(data, Mapping) else data
        return tuple(
            IssueRecord(int(item["number"]), str(item.get("state", "")), str(item.get("body", "")), str(item.get("html_url", "")))
            for item in items
            if isinstance(item, Mapping) and isinstance(item.get("number"), int)
        )

    def create_followup_issue(self, body: str) -> IssueRecord:
        data = _data(self.gh.write("issue.create", {"body": body, "title": "Dependabot batch follow-up"}, gate=self._gate_write("issue-create")))
        return IssueRecord(int(data["number"]), str(data.get("state", "open")), str(data.get("body", body)), str(data.get("html_url", "")))

    def update_followup_issue(self, number: int, body: str) -> IssueRecord:
        data = _data(self.gh.write("issue.update", {"number": number, "body": body}, gate=self._gate_write("issue-update")))
        return IssueRecord(number, str(data.get("state", "open")), str(data.get("body", body)), str(data.get("html_url", "")))

    def close_pr(self, number: int, expected_head_sha: str) -> None:
        self.gh.write("pr.close", {"number": number}, gate=self._gate_write("close-pr"))

    def check_urls(self, pr: PullRequestSnapshot) -> tuple[str, ...]:
        return self._check_urls.get(pr.number, ())


def string_map_from(value: Mapping[str, Any], key: str) -> dict[str, str]:
    raw = value.get(key, {})
    if not isinstance(raw, Mapping) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in raw.items()):
        raise ConcreteAdapterError(f"lifecycle script {key} is not a string map")
    return dict(raw)
