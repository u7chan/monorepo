#!/usr/bin/env python3
"""Deterministic building blocks for the Dependabot PR batch skill.

This module deliberately keeps GitHub, clock, process, and Docker operations
behind small injected boundaries.  The default command line entry point only
reads a JSON snapshot and produces an audit report; it never performs a
network or repository mutation.  A later live adapter must use
``MutationGate`` before calling any writer.

The module uses only the Python standard library so that the security
decisions can be tested in a clean checkout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence
from urllib.parse import urlparse


REQUIRED_LABEL = "dependabot-auto-process"
DEFAULT_BRANCH = "main"
DEPENDABOT_LOGINS = frozenset({"dependabot[bot]", "dependabot-preview[bot]"})
DEFAULT_FIX_ACTORS = frozenset({"github-actions[bot]", "dependabot-batch[bot]"})
FIX_TRAILER = "Dependabot-Batch-Fix"
FIX_MARKER_RE = re.compile(
    r"^dependabot-batch/v1/pr-(?P<number>[1-9][0-9]*)/source-(?P<sha>[0-9a-f]{7,64})$"
)
IDEMPOTENCY_MARKER_RE = re.compile(
    r"<!--\s*(?P<marker>dependabot-batch:v1:[a-f0-9]{32})\s*-->"
)
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SAFE_PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SAFE_IMAGE_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9./:_-]{0,127}$")


def _has_forbidden_mount_or_secret_flag(argv: Sequence[str]) -> bool:
    """Reject container credential/mount flags without rejecting pytest -v."""

    forbidden = {"--secret", "--ssh", "--mount", "--volume"}
    if any(item in forbidden for item in argv):
        return True
    return bool(argv and argv[0] in {"docker", "docker-compose", "podman"} and "-v" in argv)


class Mode(str, Enum):
    AUDIT_ONLY = "audit-only"
    WRITE = "write"


class Status(str, Enum):
    SUCCESS = "success"
    OPEN = "open"
    CLOSED = "closed"
    SKIPPED = "skipped"
    BLOCKED = "blocked"


class TrustStatus(str, Enum):
    TRUSTED = "trusted"
    REJECTED = "rejected"


class PreflightStatus(str, Enum):
    PASS = "pass"
    BLOCKED = "blocked"
    UNKNOWN = "unknown"


class CIClassification(str, Enum):
    SUCCESS = "success"
    RUNNING = "running"
    TRANSIENT = "transient"
    DEPENDENCY_CAUSED = "dependency-caused"
    EXTERNAL_UNKNOWN = "external/unknown"
    TIMEOUT = "timeout"
    WRITE_NOT_AUTHORIZED = "write-not-authorized"


class WriteDenied(PermissionError):
    """Raised whenever a mutation is attempted without current-turn consent."""


class SnapshotDrift(RuntimeError):
    """The GitHub object changed after the expected SHA was captured."""


class MatrixError(ValueError):
    """The repository verification matrix is incomplete or unsafe."""


class BoundaryError(ValueError):
    """An operation attempted to leave the fixed GitHub boundary."""


def _normalise_instruction(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


# These are deliberately exact phrases.  A substring in an Issue, PR body,
# comment, changelog, or release note is never passed to this function.
EXPLICIT_WRITE_INSTRUCTIONS = frozenset(
    {
        _normalise_instruction("BotのPR処理お願い"),
        _normalise_instruction("Dependabot PRをまとめて処理して"),
        _normalise_instruction("process Dependabot PRs"),
        _normalise_instruction("process Dependabot pull requests"),
        _normalise_instruction("process the Dependabot PR batch"),
    }
)


@dataclass(frozen=True)
class AuthorizationDecision:
    """The only input that can enable writes in a batch run.

    ``source`` is supplied by the caller that owns the current conversation,
    not by GitHub data.  The public CLI defaults to ``audit-only`` and does
    not derive this value from a snapshot.
    """

    mode: Mode
    source: str
    reason: str

    @property
    def allows_write(self) -> bool:
        return self.mode is Mode.WRITE and self.source == "current_turn_human"


def evaluate_authorization(
    current_turn_instruction: str | None,
    *,
    source: str = "current_turn_human",
    requested_mode: Mode | str = Mode.WRITE,
) -> AuthorizationDecision:
    """Evaluate a current-turn instruction without consulting external text.

    Exact matching is intentional: ambiguous instructions become audit-only.
    Passing ``source='github'`` (or any other source) can never enable a
    write, even when its text happens to contain an allowed phrase.
    """

    mode = Mode(requested_mode)
    if mode is Mode.AUDIT_ONLY:
        return AuthorizationDecision(mode, source, "audit-only requested")
    if source != "current_turn_human":
        return AuthorizationDecision(
            Mode.AUDIT_ONLY, source, "write authorization source is not current-turn human"
        )
    if current_turn_instruction is None:
        return AuthorizationDecision(
            Mode.AUDIT_ONLY, source, "no direct current-turn instruction"
        )
    if _normalise_instruction(current_turn_instruction) not in EXPLICIT_WRITE_INSTRUCTIONS:
        return AuthorizationDecision(
            Mode.AUDIT_ONLY, source, "instruction is ambiguous or not an exact write command"
        )
    return AuthorizationDecision(Mode.WRITE, source, "exact current-turn human instruction")


@dataclass
class MutationGate:
    """A small, mandatory guard for all GitHub and repository writes."""

    authorization: AuthorizationDecision
    attempted_operations: list[str] = field(default_factory=list)

    def can_write(self) -> bool:
        return self.authorization.allows_write

    def require_write(self, operation: str) -> None:
        self.attempted_operations.append(operation)
        if not self.can_write():
            raise WriteDenied(
                f"{operation} is disabled: {self.authorization.reason}"
            )


def _login(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        login = value.get("login")
        return login if isinstance(login, str) else None
    return None


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _labels(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    result: list[str] = []
    for item in value:
        if isinstance(item, str):
            result.append(item)
        elif isinstance(item, Mapping) and isinstance(item.get("name"), str):
            result.append(item["name"])
    return tuple(result)


@dataclass(frozen=True)
class CommitSnapshot:
    sha: str
    message: str = ""
    author_login: str | None = None
    committer_login: str | None = None
    trailers: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "CommitSnapshot":
        raw_commit = value.get("commit")
        raw_commit = raw_commit if isinstance(raw_commit, Mapping) else {}
        message = value.get("message") or raw_commit.get("message")
        message = message if isinstance(message, str) else ""
        author = _login(value.get("author")) or _login(raw_commit.get("author"))
        committer = _login(value.get("committer")) or _login(raw_commit.get("committer"))
        raw_trailers = value.get("trailers")
        trailers: dict[str, str] = {}
        if isinstance(raw_trailers, Mapping):
            trailers.update(
                (str(key), str(item))
                for key, item in raw_trailers.items()
                if isinstance(item, (str, int, float))
            )
        parsed = parse_commit_trailers(message)
        for key, item in parsed.items():
            trailers.setdefault(key, item)
        sha = value.get("sha")
        if not isinstance(sha, str) or not sha:
            raise ValueError("commit snapshot requires a non-empty sha")
        return cls(sha, message, author, committer, trailers)


def parse_commit_trailers(message: str) -> dict[str, str]:
    """Parse only the dedicated trailer; commit text is never executed."""

    trailers: dict[str, str] = {}
    for line in message.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if key == FIX_TRAILER and value:
            trailers[key] = value
    return trailers


@dataclass(frozen=True)
class PullRequestSnapshot:
    number: int
    html_url: str
    state: str
    draft: bool
    merged: bool
    labels: tuple[str, ...]
    author_login: str | None
    author_type: str | None
    base_ref: str
    base_sha: str
    head_ref: str
    head_sha: str
    default_branch: str = DEFAULT_BRANCH
    commits: tuple[CommitSnapshot, ...] = ()
    commits_complete: bool = True
    changed_files: tuple[str, ...] = ()
    mergeable: str | None = None
    body: str = ""

    @classmethod
    def from_mapping(
        cls, value: Mapping[str, Any], *, default_branch: str = DEFAULT_BRANCH
    ) -> "PullRequestSnapshot":
        head = value.get("head") if isinstance(value.get("head"), Mapping) else {}
        base = value.get("base") if isinstance(value.get("base"), Mapping) else {}
        user = value.get("user")
        number = value.get("number")
        if not isinstance(number, int):
            raise ValueError("pull request snapshot requires an integer number")

        raw_commits = value.get("commits")
        commits = (
            tuple(CommitSnapshot.from_mapping(item) for item in raw_commits)
            if isinstance(raw_commits, list)
            else ()
        )
        def required_string(mapping: Mapping[str, Any], key: str) -> str:
            item = mapping.get(key)
            if not isinstance(item, str) or not item:
                raise ValueError(f"pull request snapshot requires {key}")
            return item

        return cls(
            number=number,
            html_url=str(value.get("html_url") or ""),
            state=str(value.get("state") or ""),
            draft=bool(value.get("draft", False)),
            merged=bool(value.get("merged", False)),
            labels=_labels(value.get("labels")),
            author_login=_login(user),
            author_type=(user.get("type") if isinstance(user, Mapping) else None),
            base_ref=required_string(base, "ref"),
            base_sha=required_string(base, "sha"),
            head_ref=required_string(head, "ref"),
            head_sha=required_string(head, "sha"),
            default_branch=default_branch,
            commits=commits,
            commits_complete=isinstance(raw_commits, list),
            changed_files=_string_tuple(value.get("changed_files") or value.get("files")),
            mergeable=(value.get("mergeable") if isinstance(value.get("mergeable"), str) else None),
            body=(value.get("body") if isinstance(value.get("body"), str) else ""),
        )

    def is_open(self) -> bool:
        return self.state.casefold() == "open" and not self.merged


def make_fix_marker(pr_number: int, source_head_sha: str) -> str:
    if pr_number < 1 or not source_head_sha or not re.fullmatch(r"[0-9a-fA-F]{7,64}", source_head_sha):
        raise ValueError("invalid source for fix marker")
    return f"dependabot-batch/v1/pr-{pr_number}/source-{source_head_sha.lower()}"


def is_valid_fix_marker(marker: str, pr_number: int) -> bool:
    match = FIX_MARKER_RE.fullmatch(marker)
    return bool(match and int(match.group("number")) == pr_number)


def is_dependabot_author(login: str | None, author_type: str | None = None) -> bool:
    # Do not accept a generic Bot type: a different bot can create a PR with a
    # label that happens to look like the selector.
    return login in DEPENDABOT_LOGINS


def trusted_commit(
    commit: CommitSnapshot,
    *,
    pr_number: int,
    fix_actors: Iterable[str] = DEFAULT_FIX_ACTORS,
) -> bool:
    if is_dependabot_author(commit.author_login) or is_dependabot_author(commit.committer_login):
        return True
    marker = commit.trailers.get(FIX_TRAILER) or parse_commit_trailers(commit.message).get(FIX_TRAILER)
    actors = set(fix_actors)
    return bool(
        marker
        and is_valid_fix_marker(marker, pr_number)
        and (commit.author_login in actors or commit.committer_login in actors)
    )


def trust_reasons(
    pr: PullRequestSnapshot,
    *,
    required_label: str = REQUIRED_LABEL,
    fix_actors: Iterable[str] = DEFAULT_FIX_ACTORS,
) -> list[str]:
    reasons: list[str] = []
    if required_label not in pr.labels:
        reasons.append("missing-required-label")
    if not is_dependabot_author(pr.author_login, pr.author_type):
        reasons.append("non-dependabot-author")
    if not pr.is_open():
        reasons.append("not-open")
    if pr.draft:
        reasons.append("draft")
    if pr.base_ref != pr.default_branch:
        reasons.append("non-default-base")
    if not pr.commits_complete:
        reasons.append("commit-history-unavailable")
    elif not pr.commits:
        reasons.append("empty-commit-history")
    else:
        unknown = [
            commit.sha
            for commit in pr.commits
            if not trusted_commit(commit, pr_number=pr.number, fix_actors=fix_actors)
        ]
        if unknown:
            reasons.append("unknown-commit:" + ",".join(sorted(unknown)))
    return reasons


@dataclass(frozen=True)
class SelectionResult:
    selected: tuple[PullRequestSnapshot, ...]
    rejected: Mapping[int, tuple[str, ...]]


def select_pull_requests(
    prs: Iterable[PullRequestSnapshot],
    *,
    required_label: str = REQUIRED_LABEL,
    default_branch: str = DEFAULT_BRANCH,
    fix_actors: Iterable[str] = DEFAULT_FIX_ACTORS,
) -> SelectionResult:
    selected: list[PullRequestSnapshot] = []
    rejected: dict[int, tuple[str, ...]] = {}
    for pr in sorted(prs, key=lambda item: item.number):
        # The snapshot's default branch is authoritative for that snapshot;
        # the explicit argument protects callers that build snapshots by hand.
        if pr.default_branch != default_branch:
            reasons = list(
                dict.fromkeys(
                    trust_reasons(pr, required_label=required_label, fix_actors=fix_actors)
                    + ["default-branch-mismatch"]
                )
            )
        else:
            reasons = trust_reasons(pr, required_label=required_label, fix_actors=fix_actors)
        if reasons:
            rejected[pr.number] = tuple(reasons)
        else:
            selected.append(pr)
    return SelectionResult(tuple(selected), rejected)


@dataclass(frozen=True)
class PackageMetadata:
    name: str
    version: str
    registry: str
    download_url: str
    integrity: str | None
    source_type: str = "registry"
    lifecycle_scripts: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "PackageMetadata":
        name = value.get("name")
        version = value.get("version")
        registry = value.get("registry")
        download_url = value.get("download_url") or value.get("url")
        if not all(isinstance(item, str) and item for item in (name, version, registry, download_url)):
            raise ValueError("package metadata requires name, version, registry and download_url")
        scripts = value.get("lifecycle_scripts")
        lifecycle = (
            {str(key): str(item) for key, item in scripts.items()}
            if isinstance(scripts, Mapping)
            else {}
        )
        integrity = value.get("integrity")
        return cls(
            name=name,
            version=version,
            registry=registry,
            download_url=download_url,
            integrity=integrity if isinstance(integrity, str) else None,
            source_type=str(value.get("source_type") or "registry"),
            lifecycle_scripts=lifecycle,
        )


@dataclass(frozen=True)
class DependencyChange:
    project: str
    package: str
    from_version: str
    to_version: str
    ecosystem: str
    manifest_version: str | None = None
    lock_version: str | None = None
    expected_integrity: str | None = None
    source_type: str = "registry"
    registry: str | None = None
    download_url: str | None = None
    script_changes: Mapping[str, str] = field(default_factory=dict)
    added_packages: tuple[str, ...] = ()
    removed_packages: tuple[str, ...] = ()
    metadata: PackageMetadata | None = None


class MetadataUnavailable(RuntimeError):
    """The registry metadata could not be fetched or was incomplete."""


@dataclass(frozen=True)
class MetadataFetchResult:
    metadata: PackageMetadata | None
    attempts: int
    error: str | None = None


def fetch_metadata_with_retry(
    fetcher: Callable[[str, str], PackageMetadata],
    package: str,
    version: str,
    *,
    max_retries: int = 2,
) -> MetadataFetchResult:
    """Fetch completeness-critical metadata, retrying at most twice."""

    if max_retries < 0:
        raise ValueError("max_retries must not be negative")
    attempts = 0
    last_error = "metadata unavailable"
    while attempts <= max_retries:
        attempts += 1
        try:
            metadata = fetcher(package, version)
            if not isinstance(metadata, PackageMetadata):
                raise MetadataUnavailable("fetcher returned invalid metadata")
            return MetadataFetchResult(metadata, attempts)
        except Exception as exc:  # injected boundary failures are data, not commands
            last_error = type(exc).__name__
    return MetadataFetchResult(None, attempts, last_error)


def _host(value: str) -> str | None:
    try:
        return urlparse(value).hostname
    except ValueError:
        return None


def _is_https_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.hostname)


def _suspicious_script(command: str) -> bool:
    lowered = command.casefold()
    patterns = (
        r"curl\b[^\n|]*\|\s*(?:sh|bash)",
        r"wget\b[^\n|]*\|\s*(?:sh|bash)",
        r"invoke-webrequest",
        r"\beval\s*\(",
        r"base64\s+(?:--decode|-d)",
        r"\$\{?\{?\s*secrets\.",
        r"github_token",
        r"npm\s+publish",
        r"chmod\s+\+x\s+/tmp",
    )
    return any(re.search(pattern, lowered) for pattern in patterns)


@dataclass(frozen=True)
class PreflightResult:
    status: PreflightStatus
    reasons: tuple[str, ...]
    metadata_attempts: int = 0
    added_packages: tuple[str, ...] = ()
    removed_packages: tuple[str, ...] = ()


class SupplyChainPreflight:
    """Static supply-chain gate that runs before install, build, or test."""

    DEFAULT_REGISTRIES = {
        "bun": frozenset({"registry.npmjs.org", "npmjs.org"}),
        "uv": frozenset({"pypi.org", "pypi.python.org", "files.pythonhosted.org"}),
    }

    def __init__(
        self,
        metadata_fetcher: Callable[[str, str], PackageMetadata] | None = None,
        *,
        max_retries: int = 2,
        allowed_registry_hosts: Mapping[str, Iterable[str]] | None = None,
    ) -> None:
        self.metadata_fetcher = metadata_fetcher
        self.max_retries = max_retries
        self.allowed_registry_hosts = {
            ecosystem: frozenset(hosts)
            for ecosystem, hosts in (allowed_registry_hosts or self.DEFAULT_REGISTRIES).items()
        }

    def check(self, change: DependencyChange) -> PreflightResult:
        reasons: list[str] = []
        source_type = change.source_type.casefold()
        if source_type not in {"registry", "index"}:
            return PreflightResult(
                PreflightStatus.BLOCKED,
                (f"unsupported-dependency-source:{source_type}",),
                added_packages=change.added_packages,
                removed_packages=change.removed_packages,
            )
        if change.manifest_version is not None and change.manifest_version != change.to_version:
            reasons.append("manifest-lock-mismatch")
        if change.lock_version is not None and change.lock_version != change.to_version:
            reasons.append("manifest-lock-mismatch")
        if change.script_changes:
            for script_name, command in sorted(change.script_changes.items()):
                if _suspicious_script(command):
                    reasons.append(f"suspicious-lifecycle-script:{script_name}")
                else:
                    reasons.append(f"lifecycle-script-reviewed:{script_name}")
        if any(reason == "manifest-lock-mismatch" for reason in reasons):
            return PreflightResult(
                PreflightStatus.BLOCKED,
                tuple(dict.fromkeys(reasons)),
                added_packages=change.added_packages,
                removed_packages=change.removed_packages,
            )
        if any(reason.startswith("suspicious-lifecycle-script:") for reason in reasons):
            return PreflightResult(
                PreflightStatus.BLOCKED,
                tuple(dict.fromkeys(reasons)),
                added_packages=change.added_packages,
                removed_packages=change.removed_packages,
            )

        metadata = change.metadata
        attempts = 0
        if metadata is None:
            if self.metadata_fetcher is None:
                return PreflightResult(
                    PreflightStatus.UNKNOWN,
                    ("required-registry-metadata-unavailable",),
                    added_packages=change.added_packages,
                    removed_packages=change.removed_packages,
                )
            fetched = fetch_metadata_with_retry(
                self.metadata_fetcher,
                change.package,
                change.to_version,
                max_retries=self.max_retries,
            )
            metadata = fetched.metadata
            attempts = fetched.attempts
            if metadata is None:
                return PreflightResult(
                    PreflightStatus.UNKNOWN,
                    ("required-registry-metadata-unavailable",),
                    metadata_attempts=attempts,
                    added_packages=change.added_packages,
                    removed_packages=change.removed_packages,
                )

        if metadata.name != change.package or metadata.version != change.to_version:
            reasons.append("package-identity-or-version-mismatch")
        registry_host = _host(metadata.registry)
        allowed_hosts = self.allowed_registry_hosts.get(change.ecosystem, frozenset())
        if not _is_https_url(metadata.registry) or registry_host not in allowed_hosts:
            reasons.append("unexpected-registry")
        if not _is_https_url(metadata.download_url):
            reasons.append("invalid-download-url")
        elif _host(metadata.download_url) not in allowed_hosts:
            reasons.append("download-url-registry-mismatch")
        if not metadata.integrity:
            return PreflightResult(
                PreflightStatus.UNKNOWN,
                tuple(dict.fromkeys(reasons + ["integrity-metadata-unavailable"])),
                metadata_attempts=attempts,
                added_packages=change.added_packages,
                removed_packages=change.removed_packages,
            )
        if change.expected_integrity and metadata.integrity != change.expected_integrity:
            reasons.append("integrity-mismatch")
        if change.registry and change.registry != metadata.registry:
            reasons.append("registry-mismatch")
        if change.download_url and change.download_url != metadata.download_url:
            reasons.append("download-url-mismatch")
        blocked = {
            "package-identity-or-version-mismatch",
            "unexpected-registry",
            "invalid-download-url",
            "download-url-registry-mismatch",
            "integrity-mismatch",
            "registry-mismatch",
            "download-url-mismatch",
        }
        status = PreflightStatus.BLOCKED if blocked.intersection(reasons) else PreflightStatus.PASS
        if not reasons:
            reasons.append("static-metadata-consistent")
        return PreflightResult(
            status,
            tuple(dict.fromkeys(reasons)),
            metadata_attempts=attempts,
            added_packages=change.added_packages,
            removed_packages=change.removed_packages,
        )


@dataclass(frozen=True)
class Footprint:
    keys: tuple[str, ...]
    global_scope: bool = False

    def conflicts(self, other: "Footprint") -> bool:
        return self.global_scope or other.global_scope or bool(set(self.keys) & set(other.keys))


def footprint_for_paths(paths: Iterable[str]) -> Footprint:
    keys: set[str] = set()
    global_scope = False
    for path in paths:
        normalized = path.replace("\\", "/").lstrip("./")
        if not normalized or normalized == ".":
            global_scope = True
            continue
        parts = normalized.split("/")
        if normalized.startswith("projects/") and len(parts) >= 2 and SAFE_PROJECT_RE.fullmatch(parts[1]):
            keys.add(f"project:{parts[1]}")
        elif normalized.startswith((".github/", ".agents/", "scripts/")) or len(parts) == 1:
            global_scope = True
        else:
            # A path not recognized by the conservative model is global.
            global_scope = True
    if global_scope:
        return Footprint(("global",), True)
    return Footprint(tuple(sorted(keys)), False)


@dataclass(frozen=True)
class FootprintedItem:
    identifier: int | str
    footprint: Footprint


def schedule_footprints(items: Iterable[FootprintedItem]) -> tuple[tuple[FootprintedItem, ...], ...]:
    """Pack non-conflicting work into deterministic parallel waves."""

    waves: list[list[FootprintedItem]] = []
    barrier = 0
    for item in items:
        # A global footprint is a barrier.  It gets its own wave and all work
        # following it starts after that wave, rather than sharing a wave with
        # an apparently independent project.
        if item.footprint.global_scope:
            waves.append([item])
            barrier = len(waves)
            continue
        placed = False
        for wave in waves[barrier:]:
            if all(not item.footprint.conflicts(existing.footprint) for existing in wave):
                wave.append(item)
                placed = True
                break
        if not placed:
            waves.append([item])
    return tuple(tuple(wave) for wave in waves)


@dataclass(frozen=True)
class CheckSpec:
    identifier: str
    kind: str
    required: bool
    argv: tuple[str, ...]
    timeout_seconds: int
    cwd: str = "."


@dataclass(frozen=True)
class DockerStageSpec:
    stage: str
    required: bool
    timeout_seconds: int


@dataclass(frozen=True)
class ProjectVerification:
    name: str
    path: str
    ecosystem: str
    checks: tuple[CheckSpec, ...]
    docker: Mapping[str, DockerStageSpec]


@dataclass(frozen=True)
class VerificationMatrix:
    version: int
    max_docker_concurrency: int
    default_timeout_seconds: int
    projects: Mapping[str, ProjectVerification]

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "VerificationMatrix":
        version = value.get("version")
        docker = value.get("docker")
        raw_projects = value.get("projects")
        if not isinstance(version, int) or not isinstance(docker, Mapping) or not isinstance(raw_projects, Mapping):
            raise MatrixError("matrix requires version, docker, and projects")
        max_concurrency = docker.get("max_concurrency")
        default_timeout = docker.get("default_timeout_seconds")
        if not isinstance(max_concurrency, int) or not isinstance(default_timeout, int):
            raise MatrixError("matrix docker settings require integer limits")
        projects: dict[str, ProjectVerification] = {}
        for name, raw in raw_projects.items():
            if not isinstance(name, str) or not isinstance(raw, Mapping):
                raise MatrixError("project matrix entries must be mappings")
            path = raw.get("path")
            ecosystem = raw.get("ecosystem")
            raw_checks = raw.get("checks")
            raw_docker = raw.get("docker")
            if not isinstance(path, str) or not isinstance(ecosystem, str) or not isinstance(raw_checks, list) or not isinstance(raw_docker, Mapping):
                raise MatrixError(f"invalid matrix entry for {name}")
            checks: list[CheckSpec] = []
            for raw_check in raw_checks:
                if not isinstance(raw_check, Mapping):
                    raise MatrixError(f"invalid check in {name}")
                identifier = raw_check.get("id")
                kind = raw_check.get("kind")
                required = raw_check.get("required")
                argv = raw_check.get("argv", [])
                timeout = raw_check.get("timeout_seconds", default_timeout)
                cwd = raw_check.get("cwd", ".")
                if not isinstance(identifier, str) or not isinstance(kind, str) or not isinstance(required, bool) or not isinstance(argv, list) or not all(isinstance(item, str) for item in argv) or not isinstance(timeout, int) or not isinstance(cwd, str):
                    raise MatrixError(f"invalid check in {name}")
                checks.append(CheckSpec(identifier, kind, required, tuple(argv), timeout, cwd))
            stages: dict[str, DockerStageSpec] = {}
            for stage_name in ("test", "final"):
                raw_stage = raw_docker.get(stage_name)
                if not isinstance(raw_stage, Mapping):
                    raise MatrixError(f"{name} must specify Docker {stage_name} requirement")
                stage = raw_stage.get("target", stage_name)
                required = raw_stage.get("required")
                timeout = raw_stage.get("timeout_seconds", default_timeout)
                if not isinstance(stage, str) or not isinstance(required, bool) or not isinstance(timeout, int):
                    raise MatrixError(f"invalid Docker {stage_name} in {name}")
                stages[stage_name] = DockerStageSpec(stage, required, timeout)
            projects[name] = ProjectVerification(name, path, ecosystem, tuple(checks), stages)
        matrix = cls(version, max_concurrency, default_timeout, projects)
        matrix.validate()
        return matrix

    def validate(self) -> None:
        if self.version != 1:
            raise MatrixError("unsupported matrix version")
        if self.max_docker_concurrency != 2:
            raise MatrixError("Docker max concurrency must be exactly 2")
        if self.default_timeout_seconds <= 0:
            raise MatrixError("Docker default timeout must be positive")
        for name, project in self.projects.items():
            if name != project.name or not SAFE_PROJECT_RE.fullmatch(name):
                raise MatrixError(f"invalid project name: {name}")
            if not project.path.startswith("projects/") or ".." in Path(project.path).parts:
                raise MatrixError(f"unsafe project path: {project.path}")
            if project.ecosystem not in {"bun", "uv"}:
                raise MatrixError(f"unsupported ecosystem for {name}")
            identifiers: set[str] = set()
            for check in project.checks:
                if check.identifier in identifiers:
                    raise MatrixError(f"duplicate check {check.identifier} in {name}")
                identifiers.add(check.identifier)
                if check.timeout_seconds <= 0:
                    raise MatrixError(f"non-positive check timeout in {name}")
                if check.required and not check.argv:
                    raise MatrixError(f"required check {check.identifier} has no argv in {name}")
                if _has_forbidden_mount_or_secret_flag(check.argv):
                    raise MatrixError(f"credential or host mount flag in check {check.identifier}")
            for stage_name, stage in project.docker.items():
                if stage.stage != stage_name and stage_name in {"test", "final"}:
                    raise MatrixError(f"Docker {stage_name} target must be {stage_name}")
                if stage.timeout_seconds <= 0:
                    raise MatrixError(f"non-positive Docker timeout in {name}")


def parse_docker_stages(dockerfile: Path) -> set[str]:
    if not dockerfile.is_file():
        return set()
    stages: set[str] = set()
    pattern = re.compile(r"^\s*FROM\s+.+?\s+AS\s+([A-Za-z0-9_-]+)\s*$", re.IGNORECASE)
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            stages.add(match.group(1).casefold())
    return stages


def dependabot_directories_from_yaml(path: Path) -> dict[str, str]:
    """Read the simple repository config without making PyYAML a runtime need."""

    result: dict[str, str] = {}
    current_ecosystem: str | None = None
    ecosystem_re = re.compile(r'^\s*-?\s*package-ecosystem:\s*["\']?([^"\'\s]+)')
    directory_re = re.compile(r'^\s*directory:\s*["\']?/projects/([^"\'\s]+)')
    for line in path.read_text(encoding="utf-8").splitlines():
        ecosystem_match = ecosystem_re.match(line)
        if ecosystem_match:
            current_ecosystem = ecosystem_match.group(1)
        directory_match = directory_re.match(line)
        if directory_match and current_ecosystem:
            result[directory_match.group(1)] = current_ecosystem
    return result


def validate_repository_matrix(
    matrix: VerificationMatrix,
    *,
    repository_root: Path,
    dependabot_config: Path,
) -> list[str]:
    errors: list[str] = []
    detected = dependabot_directories_from_yaml(dependabot_config)
    if set(detected) != set(matrix.projects):
        errors.append(
            "matrix/config coverage mismatch: "
            f"missing={sorted(set(detected) - set(matrix.projects))} "
            f"extra={sorted(set(matrix.projects) - set(detected))}"
        )
    for name, ecosystem in sorted(detected.items()):
        project = matrix.projects.get(name)
        if project is None:
            continue
        if project.ecosystem != ecosystem:
            errors.append(f"{name}: ecosystem mismatch")
        project_path = repository_root / project.path
        if not project_path.is_dir():
            errors.append(f"{name}: project path is missing")
            continue
        if not (project_path / ("package.json" if ecosystem == "bun" else "pyproject.toml")).is_file():
            errors.append(f"{name}: manifest is missing")
        lock_name = "bun.lock" if ecosystem == "bun" else "uv.lock"
        if not (project_path / lock_name).is_file():
            errors.append(f"{name}: {lock_name} is missing")
        stages = parse_docker_stages(project_path / "Dockerfile")
        for stage_name, stage in project.docker.items():
            if stage.required and stage.stage.casefold() not in stages:
                errors.append(f"{name}: required Docker {stage_name} target is missing")
    return errors


@dataclass(frozen=True)
class DockerBuildSpec:
    project: str
    context: str
    stage: str
    image_tag: str
    commit_sha: str
    timeout_seconds: int

    def argv(self) -> tuple[str, ...]:
        if not SAFE_PROJECT_RE.fullmatch(self.project):
            raise BoundaryError("unsafe Docker project name")
        if not SAFE_IMAGE_TAG_RE.fullmatch(self.image_tag):
            raise BoundaryError("unsafe Docker image tag")
        if self.stage not in {"test", "final"}:
            raise BoundaryError("Docker stage is not allowlisted")
        if self.timeout_seconds <= 0:
            raise BoundaryError("Docker timeout must be positive")
        if ".." in Path(self.context).parts or Path(self.context).is_absolute():
            raise BoundaryError("Docker context must be a repository-relative path")
        return (
            "docker",
            "build",
            "--progress",
            "plain",
            "--build-arg",
            f"COMMIT_HASH={self.commit_sha}",
            "--target",
            self.stage,
            "--tag",
            self.image_tag,
            self.context,
        )


def docker_specs_for_project(
    matrix: VerificationMatrix,
    project: str,
    *,
    repository_root: Path,
    commit_sha: str,
) -> tuple[DockerBuildSpec, ...]:
    if project not in matrix.projects:
        raise MatrixError(f"project is not in verification matrix: {project}")
    definition = matrix.projects[project]
    stages = parse_docker_stages(repository_root / definition.path / "Dockerfile")
    result: list[DockerBuildSpec] = []
    for stage_name in ("test", "final"):
        stage = definition.docker[stage_name]
        if stage.stage.casefold() not in stages:
            if stage.required:
                raise MatrixError(f"required Docker {stage_name} target is missing")
            # There is intentionally no normal-build fallback here.  An
            # absent optional target is skipped, not reported as a test pass.
            continue
        image_tag = f"dependabot-batch/{project}/{stage_name}:{commit_sha[:12]}"
        result.append(
            DockerBuildSpec(
                project,
                definition.path,
                stage_name,
                image_tag,
                commit_sha,
                stage.timeout_seconds,
            )
        )
    return tuple(result)


class ProcessRunner(Protocol):
    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: int,
        env: Mapping[str, str] | None = None,
    ) -> Any:
        ...


class SecureProcessRunner:
    """Run only argument arrays with a deliberately minimal environment."""

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: int,
        env: Mapping[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if not argv or any(not isinstance(item, str) or not item for item in argv):
            raise BoundaryError("process argv must be a non-empty string array")
        if _has_forbidden_mount_or_secret_flag(argv):
            raise BoundaryError("credential or host-mount arguments are forbidden")
        clean_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(cwd),
            "CI": "1",
        }
        if env:
            clean_env.update({key: value for key, value in env.items() if key in {"PATH", "HOME", "CI"}})
        return subprocess.run(
            list(argv),
            cwd=cwd,
            env=clean_env,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )


@dataclass(frozen=True)
class CheckResult:
    identifier: str
    status: str
    returncode: int | None = None
    timed_out: bool = False
    error: str | None = None


def verification_passed(results: Iterable[CheckResult]) -> bool:
    """Treat only successful or explicitly not-required checks as passing."""

    return all(result.status in {"passed", "not-required"} for result in results)


class MatrixCheckRunner:
    """Execute only matrix-declared checks with per-command timeouts."""

    def __init__(self, runner: ProcessRunner, repository_root: Path) -> None:
        self.runner = runner
        self.repository_root = repository_root.resolve()

    def run_project(self, project: ProjectVerification) -> tuple[CheckResult, ...]:
        results: list[CheckResult] = []
        for check in project.checks:
            if not check.required and not check.argv:
                results.append(CheckResult(check.identifier, "not-required"))
                continue
            if not check.argv:
                results.append(CheckResult(check.identifier, "missing-command", error="matrix command is empty"))
                continue
            cwd = (self.repository_root / check.cwd).resolve()
            if self.repository_root not in cwd.parents and cwd != self.repository_root:
                results.append(CheckResult(check.identifier, "unsafe-cwd", error="cwd escapes repository"))
                continue
            try:
                completed = self.runner.run(
                    check.argv,
                    cwd=cwd,
                    timeout_seconds=check.timeout_seconds,
                )
                returncode = getattr(completed, "returncode", None)
                results.append(
                    CheckResult(
                        check.identifier,
                        "passed" if returncode == 0 else "failed",
                        returncode=returncode,
                    )
                )
            except subprocess.TimeoutExpired:
                results.append(CheckResult(check.identifier, "timeout", timed_out=True))
            except Exception as exc:
                results.append(CheckResult(check.identifier, "failed", error=type(exc).__name__))
        return tuple(results)


class ResourceCleaner(Protocol):
    def remove_image(self, image_tag: str) -> None:
        ...

    def remove_worktree(self, path: Path) -> None:
        ...


class DockerResourceCleaner:
    """Cleanup of resources created by this run; never calls system prune."""

    def __init__(self, runner: ProcessRunner, repository_root: Path) -> None:
        self.runner = runner
        self.repository_root = repository_root

    def remove_image(self, image_tag: str) -> None:
        if not SAFE_IMAGE_TAG_RE.fullmatch(image_tag):
            raise BoundaryError("refusing to remove an unsafe image tag")
        self.runner.run(
            ("docker", "image", "rm", "--force", image_tag),
            cwd=self.repository_root,
            timeout_seconds=60,
        )

    def remove_worktree(self, path: Path) -> None:
        resolved = path.resolve()
        root = self.repository_root.resolve()
        if root not in resolved.parents:
            raise BoundaryError("refusing to remove a worktree outside the repository")
        self.runner.run(
            ("git", "worktree", "remove", "--force", str(resolved)),
            cwd=self.repository_root,
            timeout_seconds=60,
        )


@dataclass(frozen=True)
class DockerBuildResult:
    project: str
    stage: str
    status: str
    returncode: int | None
    timed_out: bool = False
    error: str | None = None


class DockerBatchRunner:
    """Run Docker targets with an enforced concurrency ceiling of two."""

    def __init__(
        self,
        runner: ProcessRunner,
        cleaner: ResourceCleaner,
        *,
        repository_root: Path,
        max_concurrency: int = 2,
    ) -> None:
        if max_concurrency != 2:
            raise MatrixError("Docker max concurrency must be exactly 2")
        self.runner = runner
        self.cleaner = cleaner
        self.repository_root = repository_root
        self.max_concurrency = max_concurrency
        self.tracked_worktrees: set[Path] = set()

    def track_worktree(self, path: Path) -> None:
        resolved = path.resolve()
        root = self.repository_root.resolve()
        if root not in resolved.parents:
            raise BoundaryError("worktree is outside repository")
        self.tracked_worktrees.add(resolved)

    def _one(self, spec: DockerBuildSpec) -> DockerBuildResult:
        try:
            completed = self.runner.run(
                spec.argv(),
                cwd=self.repository_root,
                timeout_seconds=spec.timeout_seconds,
            )
            returncode = getattr(completed, "returncode", None)
            status = "passed" if returncode == 0 else "failed"
            return DockerBuildResult(spec.project, spec.stage, status, returncode)
        except subprocess.TimeoutExpired:
            return DockerBuildResult(spec.project, spec.stage, "timeout", None, timed_out=True)
        except Exception as exc:
            return DockerBuildResult(spec.project, spec.stage, "failed", None, error=type(exc).__name__)
        finally:
            # The image tag is deterministic and belongs exclusively to this
            # build.  Do not delete arbitrary images or call docker prune.
            try:
                self.cleaner.remove_image(spec.image_tag)
            except Exception:
                # Cleanup failures remain visible in the result only through
                # the audit boundary; they must not trigger broad cleanup.
                pass

    def run(self, specs: Iterable[DockerBuildSpec]) -> tuple[DockerBuildResult, ...]:
        ordered = tuple(specs)
        results: dict[int, DockerBuildResult] = {}
        with ThreadPoolExecutor(max_workers=self.max_concurrency) as executor:
            futures = {executor.submit(self._one, spec): index for index, spec in enumerate(ordered)}
            for future in as_completed(futures):
                results[futures[future]] = future.result()
        for path in sorted(self.tracked_worktrees, key=str):
            try:
                self.cleaner.remove_worktree(path)
            except Exception:
                pass
        return tuple(results[index] for index in range(len(ordered)))


@dataclass(frozen=True)
class CheckObservation:
    name: str
    status: str
    conclusion: str | None = None
    details_url: str | None = None
    run_id: int | None = None


@dataclass(frozen=True)
class CIObservation:
    head_sha: str
    checks: tuple[CheckObservation, ...]
    failure_code: str | None = None
    main_success: bool = False
    pr_reproducible: bool = False
    dependency_causation: bool = False


@dataclass(frozen=True)
class CIResult:
    classification: CIClassification
    reason: str
    head_sha: str
    reruns: int = 0


TRANSIENT_FAILURE_CODES = frozenset({"timeout", "cancelled", "runner-failure", "registry-5xx"})


def classify_ci(observation: CIObservation, *, expected_head_sha: str) -> CIClassification:
    if observation.head_sha != expected_head_sha:
        return CIClassification.EXTERNAL_UNKNOWN
    if any(check.status.casefold() not in {"completed", "success", "failure"} for check in observation.checks):
        return CIClassification.RUNNING
    if observation.checks and all(check.conclusion == "success" for check in observation.checks):
        return CIClassification.SUCCESS
    if observation.failure_code in TRANSIENT_FAILURE_CODES:
        return CIClassification.TRANSIENT
    if observation.main_success and observation.pr_reproducible and observation.dependency_causation:
        return CIClassification.DEPENDENCY_CAUSED
    return CIClassification.EXTERNAL_UNKNOWN


class Clock(Protocol):
    def monotonic(self) -> float:
        ...

    def sleep(self, seconds: float) -> None:
        ...


class SystemClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


class CIWaiter:
    DEADLINE_SECONDS = 30 * 60

    def __init__(
        self,
        clock: Clock | None = None,
        *,
        poll_seconds: int = 60,
        deadline_seconds: int = DEADLINE_SECONDS,
        max_reruns: int = 1,
    ) -> None:
        self.clock = clock or SystemClock()
        self.poll_seconds = poll_seconds
        self.deadline_seconds = deadline_seconds
        self.max_reruns = max_reruns

    def wait(
        self,
        expected_head_sha: str,
        observe: Callable[[str], CIObservation],
        rerun: Callable[[CIObservation], None],
        *,
        gate: MutationGate,
    ) -> CIResult:
        started = self.clock.monotonic()
        reruns = 0
        while True:
            try:
                observation = observe(expected_head_sha)
            except Exception as exc:
                return CIResult(CIClassification.EXTERNAL_UNKNOWN, f"observation-error:{type(exc).__name__}", expected_head_sha, reruns)
            classification = classify_ci(observation, expected_head_sha=expected_head_sha)
            if classification is CIClassification.SUCCESS:
                return CIResult(classification, "all-required-checks-succeeded", expected_head_sha, reruns)
            if classification is CIClassification.RUNNING:
                elapsed = self.clock.monotonic() - started
                if elapsed >= self.deadline_seconds:
                    return CIResult(CIClassification.TIMEOUT, "30-minute CI deadline exceeded", expected_head_sha, reruns)
                self.clock.sleep(min(self.poll_seconds, self.deadline_seconds - elapsed))
                continue
            if classification is CIClassification.TRANSIENT and reruns < self.max_reruns:
                try:
                    gate.require_write("rerun-ci")
                except WriteDenied:
                    return CIResult(CIClassification.WRITE_NOT_AUTHORIZED, "transient CI cannot be rerun in audit-only mode", expected_head_sha, reruns)
                rerun(observation)
                reruns += 1
                continue
            if classification is CIClassification.TRANSIENT:
                return CIResult(classification, "transient failure after rerun limit", expected_head_sha, reruns)
            return CIResult(classification, "CI failure is not an allowlisted transient or proven dependency failure", expected_head_sha, reruns)


@dataclass(frozen=True)
class RepairDiagnosis:
    dependency_caused: bool
    fix_available: bool
    summary: str


@dataclass(frozen=True)
class FixCommit:
    sha: str
    message: str
    marker: str


def make_fix_commit_message(summary: str, marker: str) -> str:
    first_line = " ".join(summary.split())[:120] or "apply dependency compatibility fix"
    return f"fix(dependabot): {first_line}\n\n{FIX_TRAILER}: {marker}"


@dataclass(frozen=True)
class RepairCycleResult:
    status: str
    cycles: int
    commits: tuple[FixCommit, ...]
    reason: str
    final_head_sha: str


class RepairCycleController:
    MAX_CYCLES = 2

    def __init__(self, gate: MutationGate) -> None:
        self.gate = gate

    def run(
        self,
        *,
        pr_number: int,
        initial_head_sha: str,
        current_head: Callable[[], str],
        diagnose: Callable[[int, str], RepairDiagnosis],
        create_commit: Callable[[RepairDiagnosis, str, str], FixCommit],
        push: Callable[[str, FixCommit], None],
        wait_for_ci: Callable[[str], CIResult],
    ) -> RepairCycleResult:
        head_sha = initial_head_sha
        commits: list[FixCommit] = []
        for cycle in range(1, self.MAX_CYCLES + 1):
            if current_head() != head_sha:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "head-drift-before-fix", head_sha)
            diagnosis = diagnose(cycle, head_sha)
            if not diagnosis.dependency_caused:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "not-proven-dependency-caused", head_sha)
            if not diagnosis.fix_available:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "no-local-fix-available", head_sha)
            try:
                self.gate.require_write("create-fix-commit")
            except WriteDenied:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "write-not-authorized", head_sha)
            marker = make_fix_marker(pr_number, head_sha)
            commit = create_commit(diagnosis, marker, make_fix_commit_message(diagnosis.summary, marker))
            if (
                not SHA_RE.fullmatch(commit.sha)
                or not is_valid_fix_marker(commit.marker, pr_number)
                or f"{FIX_TRAILER}: {commit.marker}" not in commit.message
            ):
                return RepairCycleResult("open", cycle - 1, tuple(commits), "fix-commit-marker-invalid", head_sha)
            if current_head() != head_sha:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "head-drift-before-push", head_sha)
            try:
                self.gate.require_write("push-fix")
                push(head_sha, commit)
            except WriteDenied:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "write-not-authorized", head_sha)
            except Exception as exc:
                return RepairCycleResult("open", cycle - 1, tuple(commits), f"push-failed:{type(exc).__name__}", head_sha)
            commits.append(commit)
            head_sha = commit.sha
            ci_result = wait_for_ci(head_sha)
            if ci_result.classification is CIClassification.SUCCESS:
                return RepairCycleResult("success", cycle, tuple(commits), "fixed-and-verified", head_sha)
            if ci_result.classification is not CIClassification.DEPENDENCY_CAUSED:
                return RepairCycleResult("open", cycle, tuple(commits), f"ci:{ci_result.classification.value}", head_sha)
        return RepairCycleResult("open", self.MAX_CYCLES, tuple(commits), "maximum-two-cycles-reached", head_sha)


def assert_expected_snapshot(
    expected: PullRequestSnapshot,
    current: PullRequestSnapshot,
) -> None:
    if current.number != expected.number:
        raise SnapshotDrift("pull request number changed")
    if current.head_sha != expected.head_sha:
        raise SnapshotDrift("head SHA changed")
    if current.base_sha != expected.base_sha:
        raise SnapshotDrift("base SHA changed")


class ExpectedSHAWriter:
    """TOCTOU gate for a single mutation."""

    def __init__(self, gate: MutationGate) -> None:
        self.gate = gate

    def run(
        self,
        operation: str,
        expected: PullRequestSnapshot,
        read_current: Callable[[], PullRequestSnapshot],
        action: Callable[[str, str], Any],
    ) -> Any:
        self.gate.require_write(operation)
        current = read_current()
        assert_expected_snapshot(expected, current)
        return action(expected.head_sha, expected.base_sha)


@dataclass(frozen=True)
class MergeResult:
    pr_number: int
    status: str
    reason: str
    merge_sha: str | None = None


class SerialMerger:
    """Squash merge one PR at a time and gate the next one on exact CD SHA."""

    def __init__(self, gate: MutationGate) -> None:
        self.gate = gate

    def merge_in_order(
        self,
        prs: Iterable[PullRequestSnapshot],
        *,
        refetch: Callable[[int], PullRequestSnapshot],
        ci_success_for_head: Callable[[str], bool],
        merge: Callable[[str], str],
        wait_for_cd: Callable[[str], bool],
    ) -> tuple[MergeResult, ...]:
        results: list[MergeResult] = []
        for expected in sorted(prs, key=lambda item: item.number):
            if not self.gate.can_write():
                results.append(MergeResult(expected.number, Status.OPEN.value, "write-not-authorized"))
                continue
            current = refetch(expected.number)
            try:
                assert_expected_snapshot(expected, current)
            except SnapshotDrift as exc:
                results.append(MergeResult(expected.number, Status.OPEN.value, str(exc)))
                continue
            if current.mergeable not in {"MERGEABLE", "mergeable"}:
                results.append(MergeResult(expected.number, Status.OPEN.value, "merge-conflict"))
                continue
            if not ci_success_for_head(current.head_sha):
                results.append(MergeResult(expected.number, Status.OPEN.value, "required-ci-not-success"))
                continue
            # A second read is intentional: the first read is for diagnosis;
            # this read is immediately before the expected-SHA mutation.
            latest = refetch(expected.number)
            try:
                assert_expected_snapshot(current, latest)
                self.gate.require_write("squash-merge")
            except (SnapshotDrift, WriteDenied) as exc:
                results.append(MergeResult(expected.number, Status.OPEN.value, str(exc)))
                continue
            try:
                merge_sha = merge(current.head_sha)
            except Exception as exc:
                results.append(MergeResult(expected.number, Status.OPEN.value, f"merge-failed:{type(exc).__name__}"))
                continue
            if not isinstance(merge_sha, str) or not merge_sha:
                results.append(MergeResult(expected.number, Status.OPEN.value, "merge-response-missing-sha"))
                break
            if not wait_for_cd(merge_sha):
                results.append(MergeResult(expected.number, Status.OPEN.value, "cd-failed-or-timeout", merge_sha))
                # No automatic revert and no later merge after a CD failure.
                break
            results.append(MergeResult(expected.number, Status.SUCCESS.value, "merged-and-cd-verified", merge_sha))
        return tuple(results)


def disposition_for(
    *,
    classification: str,
    preflight: PreflightResult | None = None,
    push_allowed: bool = True,
    manual_intervention: bool = False,
) -> str:
    """Return one of ``close``, ``open``, or ``merge`` without mutating."""

    if manual_intervention or not push_allowed:
        return "open"
    if preflight and preflight.status is PreflightStatus.BLOCKED:
        if any(
            reason.startswith("unsupported-dependency-source:")
            or reason == "integrity-mismatch"
            or reason == "unexpected-registry"
            or reason.startswith("suspicious-lifecycle-script:")
            for reason in preflight.reasons
        ):
            return "close"
    if classification in {CIClassification.DEPENDENCY_CAUSED.value, "dependency-incompatibility"}:
        return "close"
    return "open"


class DispositionExecutor:
    """Apply a close disposition only after comment and SHA checks."""

    def __init__(self, gate: MutationGate) -> None:
        self.gate = gate

    def apply(
        self,
        expected: PullRequestSnapshot,
        *,
        disposition: str,
        read_current: Callable[[], PullRequestSnapshot],
        comment: Callable[[str], Any],
        close: Callable[[str], Any],
        comment_body: str,
    ) -> str:
        if disposition != "close":
            return "open"
        try:
            self.gate.require_write("close-comment")
            current = read_current()
            assert_expected_snapshot(expected, current)
            comment(comment_body)
            self.gate.require_write("close-pr")
            current = read_current()
            assert_expected_snapshot(expected, current)
            close(expected.head_sha)
        except (WriteDenied, SnapshotDrift):
            return "open"
        except Exception:
            # A failed comment/close boundary leaves the PR open and is
            # represented in the caller's audit record.
            return "open"
        return "closed"


@dataclass(frozen=True)
class CommentRecord:
    identifier: int
    body: str
    html_url: str = ""


@dataclass(frozen=True)
class IssueRecord:
    number: int
    state: str
    body: str
    html_url: str = ""


def make_idempotency_marker(
    project: str,
    package: str,
    from_version: str,
    to_version: str,
) -> str:
    canonical = "\x1f".join((project, package, from_version, to_version))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
    return f"dependabot-batch:v1:{digest}"


def embed_marker(body: str, marker: str) -> str:
    if not re.fullmatch(r"dependabot-batch:v1:[a-f0-9]{32}", marker):
        raise ValueError("invalid idempotency marker")
    return f"{body.rstrip()}\n\n<!-- {marker} -->"


def marker_in_body(body: str, marker: str) -> bool:
    return marker in {match.group("marker") for match in IDEMPOTENCY_MARKER_RE.finditer(body)}


@dataclass(frozen=True)
class CommentMutation:
    action: str
    comment_id: int | None
    body: str


def plan_idempotent_comment(
    marker: str,
    body: str,
    comments: Iterable[CommentRecord],
) -> CommentMutation:
    marked = sorted(
        (comment for comment in comments if marker_in_body(comment.body, marker)),
        key=lambda comment: comment.identifier,
    )
    if marked:
        # Update the oldest matching marker instead of creating duplicates.
        return CommentMutation("update", marked[0].identifier, embed_marker(body, marker))
    return CommentMutation("create", None, embed_marker(body, marker))


@dataclass(frozen=True)
class IssuePlan:
    action: str
    issue: IssueRecord | None
    marker: str


def plan_followup_issue(marker: str, issues: Iterable[IssueRecord]) -> IssuePlan:
    matching = sorted(
        (issue for issue in issues if marker_in_body(issue.body, marker)),
        key=lambda issue: issue.number,
    )
    if not matching:
        return IssuePlan("create", None, marker)
    open_issue = next((issue for issue in matching if issue.state.casefold() == "open"), None)
    if open_issue:
        return IssuePlan("reuse-open", open_issue, marker)
    # Closed Issues are references only.  Never reopen and never create a
    # replacement for a closed matching marker.
    return IssuePlan("reference-closed", matching[0], marker)


class FollowupIssueWriter(Protocol):
    def create(self, body: str) -> IssueRecord:
        ...

    def update(self, number: int, body: str) -> IssueRecord:
        ...


class FollowupIssueManager:
    """Idempotent issue create/update boundary with a post-create re-search."""

    def __init__(self, gate: MutationGate) -> None:
        self.gate = gate

    def ensure(
        self,
        marker: str,
        body: str,
        *,
        search_all: Callable[[], Iterable[IssueRecord]],
        writer: FollowupIssueWriter,
    ) -> IssuePlan:
        current = tuple(search_all())
        plan = plan_followup_issue(marker, current)
        if plan.action == "reuse-open" and plan.issue is not None:
            # Existing marker is authoritative.  Updating it is allowed when
            # the structured details changed, but never creates a duplicate.
            if plan.issue.body != body:
                try:
                    self.gate.require_write("issue-update")
                except WriteDenied:
                    return IssuePlan("reference-open", plan.issue, marker)
                updated = writer.update(plan.issue.number, body)
                return IssuePlan("updated-open", updated, marker)
            return plan
        if plan.action == "reference-closed":
            return plan
        try:
            self.gate.require_write("issue-create")
        except WriteDenied:
            return IssuePlan("audit-only-create", None, marker)
        created = writer.create(body)
        # Re-search open and closed records after create.  If a race produced
        # a lower-numbered matching Issue, report the deterministic winner
        # rather than pretending the created record is unique.
        after = tuple(search_all())
        matching = sorted(
            (issue for issue in after if marker_in_body(issue.body, marker)),
            key=lambda issue: issue.number,
        )
        if len(matching) > 1:
            return IssuePlan("duplicate-detected", matching[0], marker)
        return IssuePlan("created", created, marker)


def build_followup_issue_body(
    *,
    summary: str,
    pr_url: str,
    project: str,
    package: str,
    from_version: str,
    to_version: str,
    base_sha: str,
    head_sha: str,
    check_urls: Iterable[str],
    classification: str,
    attempts: Iterable[str],
    reproduction: str,
    recommendation: str,
    close_reason: str,
    marker: str,
) -> str:
    urls = "\n".join(f"- {redact_text(url)}" for url in check_urls) or "- なし"
    history = "\n".join(f"- {redact_text(item)}" for item in attempts) or "- なし"
    return (
        f"<!-- {marker} -->\n"
        "## 概要\n"
        f"{redact_text(summary)}\n\n"
        "## 対象PR・project\n"
        f"- PR: {redact_text(pr_url)}\n- project: {redact_text(project)}\n\n"
        "## package/version\n"
        f"- package: {redact_text(package)}\n- 更新前: {redact_text(from_version)}\n- 更新後: {redact_text(to_version)}\n\n"
        "## base/head SHA\n"
        f"- base: {redact_text(base_sha)}\n- head: {redact_text(head_sha)}\n\n"
        "## 失敗check/run URL\n"
        f"{urls}\n\n"
        "## 分類根拠\n"
        f"{redact_text(classification)}\n\n"
        "## 試行履歴\n"
        f"{history}\n\n"
        "## 再現手順\n"
        f"{redact_text(reproduction)}\n\n"
        "## 推奨対応\n"
        f"{redact_text(recommendation)}\n\n"
        "## Close理由\n"
        f"{redact_text(close_reason) or 'なし'}"
    )


SECRET_PATTERNS = (
    re.compile(r"\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]+\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*[^\s,;]+", re.IGNORECASE),
)
QUERY_PATTERN = re.compile(r"(https?://[^\s?]+)\?[^\s]+", re.IGNORECASE)


def redact_text(value: str) -> str:
    result = value
    for pattern in SECRET_PATTERNS:
        result = pattern.sub("[REDACTED]", result)
    return QUERY_PATTERN.sub(r"\1?[REDACTED]", result)


@dataclass(frozen=True)
class AuditRecord:
    pr_number: int
    pr_url: str
    base_sha: str
    head_sha: str
    decision: str
    reason: str
    check_urls: tuple[str, ...] = ()
    fix_commit: str | None = None
    mutation_result: str = "open"
    issue_url: str | None = None
    remaining: str = ""

    def redacted(self) -> "AuditRecord":
        return AuditRecord(
            self.pr_number,
            redact_text(self.pr_url),
            redact_text(self.base_sha),
            redact_text(self.head_sha),
            redact_text(self.decision),
            redact_text(self.reason),
            tuple(redact_text(url) for url in self.check_urls),
            redact_text(self.fix_commit) if self.fix_commit else None,
            redact_text(self.mutation_result),
            redact_text(self.issue_url) if self.issue_url else None,
            redact_text(self.remaining),
        )


class AuditAggregator:
    COLUMNS = (
        "PR",
        "URL",
        "base SHA",
        "head SHA",
        "判定と根拠",
        "check/run URL",
        "修正commit",
        "merge/close/open",
        "Issue",
        "残課題",
    )

    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    def add(self, record: AuditRecord) -> None:
        self.records.append(record.redacted())

    @staticmethod
    def _cell(value: str | None) -> str:
        return redact_text((value or "").replace("\n", " ").replace("|", "\\|"))

    def render_markdown(self) -> str:
        lines = [
            "| " + " | ".join(self.COLUMNS) + " |",
            "| " + " | ".join("---" for _ in self.COLUMNS) + " |",
        ]
        for record in sorted(self.records, key=lambda item: item.pr_number):
            lines.append(
                "| "
                + " | ".join(
                    (
                        str(record.pr_number),
                        self._cell(record.pr_url),
                        self._cell(record.base_sha),
                        self._cell(record.head_sha),
                        self._cell(f"{record.decision}: {record.reason}"),
                        self._cell(", ".join(record.check_urls)),
                        self._cell(record.fix_commit),
                        self._cell(record.mutation_result),
                        self._cell(record.issue_url),
                        self._cell(record.remaining),
                    )
                )
                + " |"
            )
        return "\n".join(lines)


@dataclass(frozen=True)
class BatchSnapshot:
    prs: tuple[PullRequestSnapshot, ...]
    selected_numbers: tuple[int, ...]


@dataclass(frozen=True)
class ReconstructedState:
    """Ephemeral state rebuilt from GitHub records on every invocation."""

    pr_number: int
    base_sha: str
    head_sha: str
    fix_markers: tuple[str, ...]
    comment_markers: tuple[str, ...]
    issue_markers: tuple[str, ...]


def reconstruct_state(
    pr: PullRequestSnapshot,
    *,
    comments: Iterable[CommentRecord] = (),
    issues: Iterable[IssueRecord] = (),
) -> ReconstructedState:
    """Rebuild idempotency evidence from GitHub, not a local durable store."""

    fix_markers = sorted(
        {
            marker
            for commit in pr.commits
            for marker in (
                commit.trailers.get(FIX_TRAILER)
                or parse_commit_trailers(commit.message).get(FIX_TRAILER),
            )
            if marker and is_valid_fix_marker(marker, pr.number)
        }
    )

    def body_markers(records: Iterable[CommentRecord | IssueRecord]) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    match.group("marker")
                    for record in records
                    for match in IDEMPOTENCY_MARKER_RE.finditer(record.body)
                }
            )
        )

    return ReconstructedState(
        pr.number,
        pr.base_sha,
        pr.head_sha,
        tuple(fix_markers),
        body_markers(comments),
        body_markers(issues),
    )


@dataclass(frozen=True)
class CandidateReport:
    pr_number: int
    status: str
    reason: str
    preflight: PreflightResult | None = None
    verification_ran: bool = False


class BatchProcessor:
    """Snapshot and gate the pure pre-merge portion of one batch."""

    def __init__(
        self,
        gate: MutationGate,
        *,
        default_branch: str = DEFAULT_BRANCH,
        preflight: SupplyChainPreflight | None = None,
    ) -> None:
        self.gate = gate
        self.default_branch = default_branch
        self.preflight = preflight or SupplyChainPreflight()

    def create_snapshot(self, prs: Iterable[PullRequestSnapshot]) -> BatchSnapshot:
        snapshot_prs = tuple(sorted(prs, key=lambda item: item.number))
        selection = select_pull_requests(snapshot_prs, default_branch=self.default_branch)
        return BatchSnapshot(snapshot_prs, tuple(pr.number for pr in selection.selected))

    def process_candidate(
        self,
        expected: PullRequestSnapshot,
        *,
        latest: Callable[[int], PullRequestSnapshot],
        change: DependencyChange,
        run_verification: Callable[[DependencyChange], bool],
    ) -> CandidateReport:
        if trust_reasons(expected):
            return CandidateReport(expected.number, Status.SKIPPED.value, "snapshot-trust-rejected")
        try:
            current = latest(expected.number)
            assert_expected_snapshot(expected, current)
        except SnapshotDrift as exc:
            return CandidateReport(expected.number, Status.OPEN.value, str(exc))
        preflight = self.preflight.check(change)
        if preflight.status is not PreflightStatus.PASS:
            return CandidateReport(expected.number, Status.OPEN.value, "supply-chain:" + ",".join(preflight.reasons), preflight, False)
        # A second read is required even though preflight is static: the
        # original GitHub judgment is discarded if the PR changed meanwhile.
        try:
            current = latest(expected.number)
            assert_expected_snapshot(expected, current)
        except SnapshotDrift as exc:
            return CandidateReport(expected.number, Status.OPEN.value, str(exc), preflight, False)
        if not self.gate.can_write():
            return CandidateReport(expected.number, Status.OPEN.value, "audit-only: verification planned but no write", preflight, False)
        try:
            verified = bool(run_verification(change))
        except Exception as exc:
            return CandidateReport(expected.number, Status.OPEN.value, f"verification-error:{type(exc).__name__}", preflight, True)
        return CandidateReport(
            expected.number,
            Status.SUCCESS.value if verified else Status.OPEN.value,
            "local-verification-passed" if verified else "local-verification-failed",
            preflight,
            True,
        )

    def process_snapshot(
        self,
        snapshot: BatchSnapshot,
        *,
        current_prs: Iterable[PullRequestSnapshot],
        latest: Callable[[int], PullRequestSnapshot],
        changes: Mapping[int, DependencyChange],
        run_verification: Callable[[DependencyChange], bool],
    ) -> tuple[CandidateReport, ...]:
        """Process only IDs captured in ``snapshot``; ignore newly added PRs."""

        current_by_number = {pr.number: pr for pr in current_prs}
        reports: list[CandidateReport] = []
        for expected in snapshot.prs:
            if expected.number not in snapshot.selected_numbers:
                continue
            if expected.number not in current_by_number:
                reports.append(CandidateReport(expected.number, Status.OPEN.value, "snapshot-object-missing"))
                continue
            dependency_change = changes.get(expected.number)
            if dependency_change is None:
                reports.append(CandidateReport(expected.number, Status.OPEN.value, "dependency-diff-unavailable"))
                continue
            reports.append(
                self.process_candidate(
                    expected,
                    latest=latest,
                    change=dependency_change,
                    run_verification=run_verification,
                )
            )
        return tuple(reports)


def load_snapshot(path: Path) -> tuple[PullRequestSnapshot, ...]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    values = raw.get("pull_requests") if isinstance(raw, Mapping) else raw
    if not isinstance(values, list):
        raise ValueError("snapshot must be a list or an object with pull_requests")
    return tuple(PullRequestSnapshot.from_mapping(item) for item in values if isinstance(item, Mapping))


def build_audit_snapshot_report(prs: Iterable[PullRequestSnapshot], *, default_branch: str = DEFAULT_BRANCH) -> AuditAggregator:
    selection = select_pull_requests(prs, default_branch=default_branch)
    aggregator = AuditAggregator()
    by_number = {pr.number: pr for pr in prs}
    for number, reasons in sorted(selection.rejected.items()):
        pr = by_number[number]
        aggregator.add(
            AuditRecord(
                number,
                pr.html_url,
                pr.base_sha,
                pr.head_sha,
                "skip",
                ",".join(reasons),
                mutation_result="open",
            )
        )
    for pr in selection.selected:
        aggregator.add(
            AuditRecord(
                pr.number,
                pr.html_url,
                pr.base_sha,
                pr.head_sha,
                "eligible",
                "audit-only snapshot; no write requested",
                mutation_result="open",
            )
        )
    return aggregator


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True, help="read-only GitHub snapshot JSON")
    parser.add_argument("--mode", choices=[mode.value for mode in Mode], default=Mode.AUDIT_ONLY.value)
    parser.add_argument("--instruction-source", default="current_turn_human")
    parser.add_argument("--current-turn-instruction")
    parser.add_argument("--default-branch", default=DEFAULT_BRANCH)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    authorization = evaluate_authorization(
        args.current_turn_instruction,
        source=args.instruction_source,
        requested_mode=Mode(args.mode),
    )
    prs = load_snapshot(args.snapshot)
    report = build_audit_snapshot_report(prs, default_branch=args.default_branch)
    print(f"mode={authorization.mode.value} reason={authorization.reason}")
    print(report.render_markdown())
    # This command intentionally stops at a report.  Live mutation adapters
    # are separate and must call MutationGate; a write request cannot turn a
    # snapshot-report command into a GitHub writer by accident.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
