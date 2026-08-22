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
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence
from urllib.parse import urlparse


REQUIRED_LABEL = "dependabot-auto-process"
DEFAULT_BRANCH = "main"
DEPENDABOT_LOGINS = frozenset({"dependabot[bot]", "dependabot-preview[bot]"})
DEPENDABOT_COMMITTERS = frozenset({"web-flow"})
# Generic github-actions[bot] is intentionally excluded: any repository
# workflow can use that identity.  Repair provenance must be rooted in the
# repository owner or a future dedicated application identity.
DEFAULT_FIX_ACTORS = frozenset({"u7chan", "dependabot-batch[bot]"})
FIX_TRAILER = "Dependabot-Batch-Fix"
FIX_MARKER_RE = re.compile(
    r"^dependabot-batch/v2/pr-(?P<number>[1-9][0-9]*)/run-(?P<run>[1-9][0-9]*)/parent-(?P<sha>[0-9a-f]{40})$"
)
IDEMPOTENCY_MARKER_RE = re.compile(
    r"<!--\s*(?P<marker>dependabot-batch:v1:[a-f0-9]{32})\s*-->"
)
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SAFE_PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SAFE_IMAGE_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9./:_-]{0,127}$")
SAFE_INVOCATION_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{7,63}$")
DOCKER_OWNERSHIP_LABEL = "com.u7chan.dependabot-batch.invocation"


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
    author_type: str | None = None
    committer_type: str | None = None
    verification_verified: bool = False
    parents: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "CommitSnapshot":
        raw_commit = value.get("commit")
        raw_commit = raw_commit if isinstance(raw_commit, Mapping) else {}
        message = value.get("message") or raw_commit.get("message")
        message = message if isinstance(message, str) else ""
        raw_author = value.get("author") if isinstance(value.get("author"), Mapping) else {}
        raw_committer = value.get("committer") if isinstance(value.get("committer"), Mapping) else {}
        author = _login(raw_author) or _login(raw_commit.get("author"))
        committer = _login(raw_committer) or _login(raw_commit.get("committer"))
        author_type = raw_author.get("type") if isinstance(raw_author.get("type"), str) else None
        committer_type = raw_committer.get("type") if isinstance(raw_committer.get("type"), str) else None
        raw_verification = value.get("verification")
        if not isinstance(raw_verification, Mapping):
            raw_verification = raw_commit.get("verification")
        verified = isinstance(raw_verification, Mapping) and raw_verification.get("verified") is True
        raw_parents = value.get("parents")
        parents = tuple(
            item if isinstance(item, str) else item.get("sha")
            for item in (raw_parents if isinstance(raw_parents, list) else [])
            if isinstance(item, str) or (isinstance(item, Mapping) and isinstance(item.get("sha"), str))
        )
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
        return cls(
            sha,
            message,
            author,
            committer,
            trailers,
            author_type,
            committer_type,
            verified,
            parents,
        )


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


def make_fix_marker(pr_number: int, source_head_sha: str, run_id: int = 1) -> str:
    if (
        pr_number < 1
        or run_id < 1
        or not source_head_sha
        or not re.fullmatch(r"[0-9a-fA-F]{40}", source_head_sha)
    ):
        raise ValueError("invalid source for fix marker")
    return f"dependabot-batch/v2/pr-{pr_number}/run-{run_id}/parent-{source_head_sha.lower()}"


def is_valid_fix_marker(
    marker: str,
    pr_number: int,
    *,
    source_head_sha: str | None = None,
    run_id: int | None = None,
) -> bool:
    match = FIX_MARKER_RE.fullmatch(marker)
    if not match or int(match.group("number")) != pr_number:
        return False
    if source_head_sha is not None and match.group("sha") != source_head_sha.casefold():
        return False
    if run_id is not None and int(match.group("run")) != run_id:
        return False
    return True


def is_dependabot_author(login: str | None, author_type: str | None = None) -> bool:
    # Do not accept a generic Bot type: a different bot can create a PR with a
    # label that happens to look like the selector.
    return login in DEPENDABOT_LOGINS


def is_verified_dependabot_commit(commit: CommitSnapshot) -> bool:
    """Accept GitHub's two documented Dependabot commit shapes.

    Dependabot may commit directly, or GitHub may apply the commit through the
    verified ``web-flow`` committer.  No other mixed identity is accepted.
    """

    if commit.author_login not in DEPENDABOT_LOGINS:
        return False
    if commit.author_type is None or commit.author_type.casefold() != "bot":
        return False
    same_bot = (
        commit.committer_login == commit.author_login
        and commit.committer_type is not None
        and commit.committer_type.casefold() == "bot"
    )
    github_applied = (
        commit.committer_login in DEPENDABOT_COMMITTERS
        and commit.committer_type is not None
        and commit.committer_type.casefold() in {"user", "bot"}
    )
    return commit.verification_verified is True and (same_bot or github_applied)


def _valid_repair_actor_shape(
    actor: str | None,
    author_type: str | None,
    committer_type: str | None,
    verified: bool,
    allowed: set[str],
) -> bool:
    if actor not in allowed or author_type is None or committer_type is None:
        return False
    expected_type = "bot" if actor.endswith("[bot]") else "user"
    if author_type.casefold() != expected_type or committer_type.casefold() != expected_type:
        return False
    # Dedicated bot commits must remain GitHub-verified.  A repository-owner
    # local commit is instead rooted in the exact owner-authored provenance
    # record reconstructed below.
    return verified if expected_type == "bot" else True


REPAIR_PROVENANCE_MARKER_RE = re.compile(r"^dependabot-batch:repair:v1:[0-9a-f]{32}$")


def make_repair_provenance_marker(
    pr_number: int,
    run_id: int,
    parent_sha: str,
    commit_sha: str,
) -> str:
    if (
        pr_number < 1
        or run_id < 1
        or not SHA_RE.fullmatch(parent_sha)
        or not SHA_RE.fullmatch(commit_sha)
    ):
        raise ValueError("invalid repair provenance context")
    canonical = "\x1f".join((str(pr_number), str(run_id), parent_sha.lower(), commit_sha.lower()))
    return "dependabot-batch:repair:v1:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def build_repair_provenance_body(record: "RepairCommitRecord") -> str:
    """Build the exact marker record written to GitHub after a repair push."""

    return (
        f"<!-- {record.provenance_marker} -->\n"
        "Dependabot batch repair provenance\n"
        f"- pr: {record.pr_number}\n"
        f"- run: {record.run_id}\n"
        f"- parent: {record.parent_sha}\n"
        f"- commit: {record.commit_sha}\n"
        f"- actor: {record.author_login}\n"
    )


@dataclass(frozen=True)
class RepairProvenanceRecord:
    """A provenance record parsed from a fetched GitHub comment/Issue."""

    record_id: int
    marker: str
    pr_number: int
    run_id: int
    parent_sha: str
    commit_sha: str
    actor: str
    body: str
    source: str = "github-state"
    source_author_login: str | None = None
    source_author_type: str | None = None


def parse_repair_provenance_record(
    record_id: int,
    body: str,
    *,
    source_author_login: str | None = None,
    source_author_type: str | None = None,
) -> RepairProvenanceRecord | None:
    """Parse only the fixed marker record returned by a GH read adapter."""

    if record_id < 1 or not isinstance(body, str):
        return None
    marker_match = re.search(r"<!--\s*(dependabot-batch:repair:v1:[0-9a-f]{32})\s*-->", body)
    fields = dict(
        re.findall(
            r"(?m)^-\s*(pr|run|parent|commit|actor):\s*([^\n]+?)\s*$",
            body,
        )
    )
    if not marker_match or not REPAIR_PROVENANCE_MARKER_RE.fullmatch(marker_match.group(1)):
        return None
    try:
        pr_number = int(fields["pr"])
        run_id = int(fields["run"])
    except (KeyError, ValueError):
        return None
    parent_sha = fields.get("parent", "").casefold()
    commit_sha = fields.get("commit", "").casefold()
    actor = fields.get("actor", "")
    marker = marker_match.group(1)
    if (
        pr_number < 1
        or run_id < 1
        or not SHA_RE.fullmatch(parent_sha)
        or not SHA_RE.fullmatch(commit_sha)
        or not actor
        or marker != make_repair_provenance_marker(pr_number, run_id, parent_sha, commit_sha)
    ):
        return None
    return RepairProvenanceRecord(
        record_id,
        marker,
        pr_number,
        run_id,
        parent_sha,
        commit_sha,
        actor,
        body,
        "github-state",
        source_author_login,
        source_author_type,
    )


@dataclass(frozen=True)
class RepairCommitRecord:
    """Commit-side evidence; it is never trusted without fetched provenance."""

    pr_number: int
    run_id: int
    parent_sha: str
    commit_sha: str
    marker: str
    author_login: str
    committer_login: str
    verification_verified: bool = True
    provenance_marker: str = ""


def trusted_commit(
    commit: CommitSnapshot,
    *,
    pr_number: int,
    fix_actors: Iterable[str] = DEFAULT_FIX_ACTORS,
    repair_chain: Iterable[RepairCommitRecord] = (),
    repair_provenance: Iterable[RepairProvenanceRecord] = (),
) -> bool:
    if is_verified_dependabot_commit(commit):
        return True
    marker = commit.trailers.get(FIX_TRAILER) or parse_commit_trailers(commit.message).get(FIX_TRAILER)
    actors = set(fix_actors)
    if not marker:
        return False
    provenance = tuple(repair_provenance)
    for record in repair_chain:
        if record.pr_number != pr_number or record.commit_sha.casefold() != commit.sha.casefold():
            continue
        if record.author_login not in actors or record.committer_login != record.author_login:
            continue
        if record.marker != marker:
            continue
        if not _valid_repair_actor_shape(
            record.author_login,
            commit.author_type,
            commit.committer_type,
            commit.verification_verified and record.verification_verified,
            actors,
        ):
            continue
        if commit.author_login != record.author_login or commit.committer_login != record.committer_login:
            continue
        if marker != record.marker:
            continue
        if not is_valid_fix_marker(
            marker,
            pr_number,
            source_head_sha=record.parent_sha,
            run_id=record.run_id,
        ):
            continue
        if commit.parents != (record.parent_sha,):
            continue
        if not any(
            item.source == "github-state"
            and item.record_id > 0
            and item.marker == record.provenance_marker
            and item.pr_number == record.pr_number
            and item.run_id == record.run_id
            and item.parent_sha == record.parent_sha
            and item.commit_sha == record.commit_sha
            and item.actor == record.author_login
            and item.source_author_login == record.author_login
            and item.source_author_type is not None
            and item.source_author_type.casefold()
            == ("bot" if record.author_login.endswith("[bot]") else "user")
            and item.body == build_repair_provenance_body(record)
            for item in provenance
        ):
            continue
        return True
    return False


def trust_reasons(
    pr: PullRequestSnapshot,
    *,
    required_label: str = REQUIRED_LABEL,
    fix_actors: Iterable[str] = DEFAULT_FIX_ACTORS,
    repair_chain: Iterable[RepairCommitRecord] = (),
    repair_provenance: Iterable[RepairProvenanceRecord] = (),
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
            if not trusted_commit(
                commit,
                pr_number=pr.number,
                fix_actors=fix_actors,
                repair_chain=repair_chain,
                repair_provenance=repair_provenance,
            )
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
    repair_chains: Mapping[int, Iterable[RepairCommitRecord]] | None = None,
    repair_provenance: Mapping[int, Iterable[RepairProvenanceRecord]] | None = None,
) -> SelectionResult:
    selected: list[PullRequestSnapshot] = []
    rejected: dict[int, tuple[str, ...]] = {}
    for pr in sorted(prs, key=lambda item: item.number):
        # The snapshot's default branch is authoritative for that snapshot;
        # the explicit argument protects callers that build snapshots by hand.
        if pr.default_branch != default_branch:
            reasons = list(
                dict.fromkeys(
                    trust_reasons(
                        pr,
                        required_label=required_label,
                        fix_actors=fix_actors,
                        repair_chain=(repair_chains or {}).get(pr.number, ()),
                        repair_provenance=(repair_provenance or {}).get(pr.number, ()),
                    )
                    + ["default-branch-mismatch"]
                )
            )
        else:
            reasons = trust_reasons(
                pr,
                required_label=required_label,
                fix_actors=fix_actors,
                repair_chain=(repair_chains or {}).get(pr.number, ()),
                repair_provenance=(repair_provenance or {}).get(pr.number, ()),
            )
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
    lifecycle_scripts_known: bool = True

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "PackageMetadata":
        name = value.get("name")
        version = value.get("version")
        registry = value.get("registry")
        download_url = value.get("download_url") or value.get("url")
        if not all(isinstance(item, str) and item for item in (name, version, registry, download_url)):
            raise ValueError("package metadata requires name, version, registry and download_url")
        scripts_known = "lifecycle_scripts" in value and isinstance(value.get("lifecycle_scripts"), Mapping)
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
            lifecycle_scripts_known=scripts_known,
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
    direct: bool = True


@dataclass(frozen=True)
class ManifestLockDiff:
    """Trusted, static manifest/lock maps captured from one PR diff.

    The maps contain resolved package versions.  A lock-only member is a
    transitive change; a manifest member is direct.  The caller must obtain
    these maps from the trusted PR diff adapter, never from a comment or PR
    body.
    """

    project: str
    ecosystem: str
    manifest_before: Mapping[str, str]
    manifest_after: Mapping[str, str]
    lock_before: Mapping[str, str]
    lock_after: Mapping[str, str]
    metadata: Mapping[str, PackageMetadata]
    script_changes: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    source_types: Mapping[str, str] = field(default_factory=dict)
    lifecycle_scripts: Mapping[str, "LifecycleScriptEvidence"] = field(default_factory=dict)


@dataclass(frozen=True)
class LifecycleScriptEvidence:
    """Manifest/lock script state captured alongside a member diff."""

    before: Mapping[str, str]
    after: Mapping[str, str]


@dataclass(frozen=True)
class GroupedReconstruction:
    changes: tuple[DependencyChange, ...]
    errors: tuple[str, ...] = ()

    @property
    def complete(self) -> bool:
        return bool(self.changes) and not self.errors


def reconstruct_grouped_changes(diff: ManifestLockDiff) -> GroupedReconstruction:
    """Reconstruct every direct, added/removed, and lock-only member.

    No package is silently copied from an ``added_packages`` hint.  Missing
    metadata, malformed script maps, and manifest/lock disagreement are
    explicit reconstruction errors and must stop all dependency execution.
    """

    errors: list[str] = []
    names = sorted(
        {
            name
            for mapping_before, mapping_after in (
                (diff.manifest_before, diff.manifest_after),
                (diff.lock_before, diff.lock_after),
            )
            for name in set(mapping_before) | set(mapping_after)
            if mapping_before.get(name) != mapping_after.get(name)
        }
    )
    if not names:
        return GroupedReconstruction((), ("no-dependency-change",))
    changes: list[DependencyChange] = []
    known_scripts = set(diff.script_changes)
    for name in names:
        manifest_before = diff.manifest_before.get(name)
        manifest_after = diff.manifest_after.get(name)
        lock_before = diff.lock_before.get(name)
        lock_after = diff.lock_after.get(name)
        if manifest_before is not None and lock_before is not None and manifest_before != lock_before:
            errors.append(f"manifest-lock-mismatch:{name}:before")
        if manifest_after is not None and lock_after is not None and manifest_after != lock_after:
            errors.append(f"manifest-lock-mismatch:{name}:after")
        from_version = manifest_before or lock_before or "absent"
        to_version = manifest_after or lock_after or "absent"
        if from_version == "absent" and to_version == "absent":
            errors.append(f"incomplete-version-member:{name}")
            continue
        package_metadata = diff.metadata.get(name)
        if package_metadata is None:
            errors.append(f"missing-package-metadata:{name}")
            continue
        expected_metadata_version = to_version if to_version != "absent" else from_version
        if package_metadata.version != expected_metadata_version:
            errors.append(f"package-version-mismatch:{name}")
        if not package_metadata.registry or not package_metadata.download_url:
            errors.append(f"missing-package-source:{name}")
        if not package_metadata.integrity:
            errors.append(f"missing-package-integrity:{name}")
        if not package_metadata.lifecycle_scripts_known:
            errors.append(f"unknown-lifecycle-script-state:{name}")
        source_type = diff.source_types.get(name, package_metadata.source_type)
        scripts = diff.script_changes.get(name, {})
        script_evidence = diff.lifecycle_scripts.get(name)
        if script_evidence is None:
            # Empty registry metadata is an authoritative no-script state;
            # any omitted/changed script claim for a package with scripts is
            # unknown and therefore blocks before execution.
            if package_metadata.lifecycle_scripts or name in diff.script_changes:
                errors.append(f"missing-lifecycle-script-evidence:{name}")
            scripts = {}
        elif not isinstance(script_evidence, LifecycleScriptEvidence):
            errors.append(f"invalid-lifecycle-script-evidence:{name}")
            scripts = {}
        else:
            if any(
                not isinstance(key, str) or not isinstance(value, str)
                for mapping in (script_evidence.before, script_evidence.after)
                for key, value in mapping.items()
            ):
                errors.append(f"invalid-lifecycle-script-evidence:{name}")
            if dict(script_evidence.after) != dict(package_metadata.lifecycle_scripts):
                errors.append(f"lifecycle-script-metadata-mismatch:{name}")
            expected_changed = {
                key: value
                for key, value in script_evidence.after.items()
                if script_evidence.before.get(key) != value
            }
            if not isinstance(scripts, Mapping) or dict(scripts) != expected_changed:
                errors.append(f"lifecycle-script-diff-mismatch:{name}")
            scripts = dict(script_evidence.after)
        changes.append(
            DependencyChange(
                project=diff.project,
                package=name,
                from_version=from_version,
                to_version=to_version,
                ecosystem=diff.ecosystem,
                manifest_version=manifest_after,
                lock_version=lock_after,
                expected_integrity=package_metadata.integrity,
                source_type=source_type,
                registry=package_metadata.registry,
                download_url=package_metadata.download_url,
                script_changes=dict(scripts),
                metadata=package_metadata,
                direct=name in diff.manifest_before or name in diff.manifest_after,
            )
        )
    for unknown_script_name in sorted(known_scripts - set(names)):
        errors.append(f"script-without-dependency-member:{unknown_script_name}")
    return GroupedReconstruction(tuple(changes), tuple(dict.fromkeys(errors)))


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


@dataclass(frozen=True)
class GroupedPreflightResult:
    status: PreflightStatus
    reasons: tuple[str, ...]
    member_results: tuple[PreflightResult, ...]
    changes: tuple[DependencyChange, ...]

    @property
    def complete(self) -> bool:
        return self.status is PreflightStatus.PASS and len(self.member_results) == len(self.changes)


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
        if not change.package or not change.ecosystem or not change.from_version or not change.to_version:
            return PreflightResult(
                PreflightStatus.BLOCKED,
                ("incomplete-dependency-member",),
                added_packages=change.added_packages,
                removed_packages=change.removed_packages,
            )
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

        expected_metadata_version = (
            change.from_version if change.to_version == "absent" else change.to_version
        )
        if metadata.name != change.package or metadata.version != expected_metadata_version:
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

    def check_grouped(
        self,
        changes: Iterable[DependencyChange],
        *,
        reconstruction_errors: Iterable[str] = (),
    ) -> GroupedPreflightResult:
        """Run every member gate before any install/build/test callback."""

        members = tuple(changes)
        reconstruction = tuple(reconstruction_errors)
        reasons = list(reconstruction)
        member_results: list[PreflightResult] = []
        for member in members:
            result = self.check(member)
            member_results.append(result)
            reasons.extend(f"{member.package}:{reason}" for reason in result.reasons)
        if reconstruction or any(result.status is PreflightStatus.BLOCKED for result in member_results):
            status = PreflightStatus.BLOCKED
        elif any(result.status is PreflightStatus.UNKNOWN for result in member_results):
            status = PreflightStatus.UNKNOWN
        else:
            status = PreflightStatus.PASS
        return GroupedPreflightResult(status, tuple(dict.fromkeys(reasons)), tuple(member_results), members)


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
    invocation_id: str = ""

    def argv(self) -> tuple[str, ...]:
        if not SAFE_PROJECT_RE.fullmatch(self.project):
            raise BoundaryError("unsafe Docker project name")
        if not SAFE_IMAGE_TAG_RE.fullmatch(self.image_tag):
            raise BoundaryError("unsafe Docker image tag")
        if not SAFE_INVOCATION_RE.fullmatch(self.invocation_id):
            raise BoundaryError("Docker invocation id is missing or unsafe")
        if f"/{self.invocation_id}/" not in self.image_tag:
            raise BoundaryError("Docker image tag is not owned by this invocation")
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
            "--label",
            f"{DOCKER_OWNERSHIP_LABEL}={self.invocation_id}",
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
    invocation_id: str | None = None,
) -> tuple[DockerBuildSpec, ...]:
    if project not in matrix.projects:
        raise MatrixError(f"project is not in verification matrix: {project}")
    definition = matrix.projects[project]
    stages = parse_docker_stages(repository_root / definition.path / "Dockerfile")
    invocation_id = invocation_id or uuid.uuid4().hex
    if not SAFE_INVOCATION_RE.fullmatch(invocation_id):
        raise BoundaryError("Docker invocation id is missing or unsafe")
    result: list[DockerBuildSpec] = []
    for stage_name in ("test", "final"):
        stage = definition.docker[stage_name]
        if stage.stage.casefold() not in stages:
            if stage.required:
                raise MatrixError(f"required Docker {stage_name} target is missing")
            # There is intentionally no normal-build fallback here.  An
            # absent optional target is skipped, not reported as a test pass.
            continue
        image_tag = f"dependabot-batch/{invocation_id}/{project}/{stage_name}:{commit_sha[:12]}"
        result.append(
            DockerBuildSpec(
                project,
                definition.path,
                stage_name,
                image_tag,
                commit_sha,
                stage.timeout_seconds,
                invocation_id,
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
    def image_exists(self, image_tag: str) -> bool:
        ...

    def image_owned(self, image_tag: str, invocation_id: str) -> bool:
        ...

    def worktree_exists(self, path: Path) -> bool:
        ...

    def remove_image(self, image_tag: str) -> None:
        ...

    def remove_worktree(self, path: Path) -> None:
        ...


class DockerResourceCleaner:
    """Cleanup of resources created by this run; never calls system prune."""

    def __init__(self, runner: ProcessRunner, repository_root: Path) -> None:
        self.runner = runner
        self.repository_root = repository_root

    def image_exists(self, image_tag: str) -> bool:
        if not SAFE_IMAGE_TAG_RE.fullmatch(image_tag):
            raise BoundaryError("refusing to inspect an unsafe image tag")
        completed = self.runner.run(
            ("docker", "image", "inspect", image_tag),
            cwd=self.repository_root,
            timeout_seconds=60,
        )
        return getattr(completed, "returncode", None) == 0

    def image_owned(self, image_tag: str, invocation_id: str) -> bool:
        if not SAFE_IMAGE_TAG_RE.fullmatch(image_tag) or not SAFE_INVOCATION_RE.fullmatch(invocation_id):
            raise BoundaryError("refusing to inspect an unsafe Docker resource")
        completed = self.runner.run(
            (
                "docker",
                "image",
                "inspect",
                "--format",
                f"{{{{ index .Config.Labels \"{DOCKER_OWNERSHIP_LABEL}\" }}}}",
                image_tag,
            ),
            cwd=self.repository_root,
            timeout_seconds=60,
        )
        return (
            getattr(completed, "returncode", None) == 0
            and getattr(completed, "stdout", "").strip() == invocation_id
        )

    def worktree_exists(self, path: Path) -> bool:
        resolved = path.resolve()
        root = self.repository_root.resolve()
        if root not in resolved.parents:
            raise BoundaryError("refusing to inspect a worktree outside the repository")
        return resolved.exists()

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
    image_preexisting: bool = False
    image_created: bool = False
    cleanup_attempted: bool = False
    cleanup_succeeded: bool = False


class DockerBatchRunner:
    """Run Docker targets with an enforced concurrency ceiling of two."""

    def __init__(
        self,
        runner: ProcessRunner,
        cleaner: ResourceCleaner,
        *,
        repository_root: Path,
        max_concurrency: int = 2,
        invocation_id: str | None = None,
    ) -> None:
        if max_concurrency != 2:
            raise MatrixError("Docker max concurrency must be exactly 2")
        self.runner = runner
        self.cleaner = cleaner
        self.repository_root = repository_root
        self.max_concurrency = max_concurrency
        self.invocation_id = invocation_id or uuid.uuid4().hex
        if not SAFE_INVOCATION_RE.fullmatch(self.invocation_id):
            raise BoundaryError("Docker invocation id is missing or unsafe")
        self.tracked_worktrees: set[Path] = set()

    def track_worktree(self, path: Path) -> bool:
        resolved = path.resolve()
        root = self.repository_root.resolve()
        if root not in resolved.parents and resolved != root:
            raise BoundaryError("worktree is outside repository")
        if self.cleaner.worktree_exists(resolved):
            return False
        self.tracked_worktrees.add(resolved)
        return True

    def _image_exists(self, image_tag: str) -> bool:
        exists = self.cleaner.image_exists(image_tag)
        if not isinstance(exists, bool):
            raise BoundaryError("Docker image probe returned a non-boolean result")
        return exists

    def _image_owned(self, image_tag: str) -> bool:
        owned = self.cleaner.image_owned(image_tag, self.invocation_id)
        if not isinstance(owned, bool):
            raise BoundaryError("Docker ownership probe returned a non-boolean result")
        return owned

    def _one(self, spec: DockerBuildSpec) -> DockerBuildResult:
        if spec.invocation_id != self.invocation_id:
            return DockerBuildResult(spec.project, spec.stage, "failed", None, error="invocation-id-mismatch")
        if not SAFE_INVOCATION_RE.fullmatch(spec.invocation_id):
            return DockerBuildResult(spec.project, spec.stage, "failed", None, error="invalid-invocation-id")
        image_preexisting = False
        image_created = False
        cleanup_attempted = False
        cleanup_succeeded = False
        returncode: int | None = None
        status = "failed"
        timed_out = False
        error: str | None = None
        try:
            image_preexisting = self._image_exists(spec.image_tag)
            if image_preexisting:
                return DockerBuildResult(
                    spec.project,
                    spec.stage,
                    "collision",
                    None,
                    error="image-tag-already-exists",
                    image_preexisting=True,
                )
            try:
                completed = self.runner.run(
                    spec.argv(),
                    cwd=self.repository_root,
                    timeout_seconds=spec.timeout_seconds,
                )
                returncode = getattr(completed, "returncode", None)
                status = "passed" if returncode == 0 else "failed"
            except subprocess.TimeoutExpired:
                status = "timeout"
                timed_out = True
            except Exception as exc:
                status = "failed"
                error = type(exc).__name__
            # A successful/failed build is not ownership evidence.  Only a
            # post-build probe proving that the previously absent tag now
            # exists grants this invocation permission to remove it.
            try:
                image_created = self._image_owned(spec.image_tag)
            except Exception as exc:
                error = error or f"image-probe:{type(exc).__name__}"
                image_created = False
            if status == "passed" and not image_created:
                status = "failed"
                error = error or "image-not-created"
        except Exception as exc:
            status = "failed"
            error = error or type(exc).__name__
        finally:
            if image_created and not image_preexisting:
                cleanup_attempted = True
                try:
                    self.cleaner.remove_image(spec.image_tag)
                    cleanup_succeeded = True
                except Exception as exc:
                    error = error or f"image-cleanup:{type(exc).__name__}"
        return DockerBuildResult(
            spec.project,
            spec.stage,
            status,
            returncode,
            timed_out,
            error,
            image_preexisting,
            image_created,
            cleanup_attempted,
            cleanup_succeeded,
        )

    def run(self, specs: Iterable[DockerBuildSpec]) -> tuple[DockerBuildResult, ...]:
        ordered = tuple(specs)
        if len({spec.image_tag for spec in ordered}) != len(ordered):
            raise BoundaryError("duplicate Docker resource tag in one invocation")
        if any(spec.invocation_id != self.invocation_id for spec in ordered):
            raise BoundaryError("Docker specs do not belong to this invocation")
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
            finally:
                self.tracked_worktrees.discard(path)
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


@dataclass(frozen=True)
class CandidateEvidence:
    """Immutable proof bundle tied to exactly one PR base/head pair."""

    pr: PullRequestSnapshot
    diff: ManifestLockDiff
    changes: tuple[DependencyChange, ...]
    preflight: GroupedPreflightResult
    local_verification: bool
    ci_result: CIResult
    evidence_token: str

    @classmethod
    def create(
        cls,
        pr: PullRequestSnapshot,
        diff: ManifestLockDiff,
        changes: Iterable[DependencyChange],
        preflight: GroupedPreflightResult,
        local_verification: bool,
        ci_result: CIResult,
    ) -> "CandidateEvidence":
        frozen_changes = tuple(changes)
        canonical = {
            "pr": pr.number,
            "base": pr.base_sha,
            "head": pr.head_sha,
            "project": diff.project,
            "members": [
                (item.package, item.from_version, item.to_version, item.expected_integrity or "")
                for item in frozen_changes
            ],
            "preflight": preflight.status.value,
            "local": local_verification,
            "ci_head": ci_result.head_sha,
            "ci": ci_result.classification.value,
        }
        token = hashlib.sha256(
            json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return cls(pr, diff, frozen_changes, preflight, local_verification, ci_result, token)

    def matches(self, pr: PullRequestSnapshot) -> bool:
        return (
            self.pr.number == pr.number
            and self.pr.base_sha == pr.base_sha
            and self.pr.head_sha == pr.head_sha
            and self.pr.mergeable == pr.mergeable
            and self.ci_result.head_sha == pr.head_sha
            and self.preflight.complete
            and self.local_verification
            and self.ci_result.classification is CIClassification.SUCCESS
        )


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

        def over_deadline() -> bool:
            # At the boundary the budget is exhausted: do not start another
            # observation or mutation at exactly 30 minutes.
            return self.clock.monotonic() - started >= self.deadline_seconds

        def timeout_result() -> CIResult:
            return CIResult(
                CIClassification.TIMEOUT,
                "30-minute CI deadline exceeded",
                expected_head_sha,
                reruns,
            )

        while True:
            if over_deadline():
                return timeout_result()
            try:
                observation = observe(expected_head_sha)
            except Exception as exc:
                if over_deadline():
                    return timeout_result()
                return CIResult(CIClassification.EXTERNAL_UNKNOWN, f"observation-error:{type(exc).__name__}", expected_head_sha, reruns)
            # An injected/live observer may spend the entire remaining
            # budget before returning a seemingly successful observation.
            if over_deadline():
                return timeout_result()
            classification = classify_ci(observation, expected_head_sha=expected_head_sha)
            if classification is CIClassification.SUCCESS:
                if over_deadline():
                    return timeout_result()
                return CIResult(classification, "all-required-checks-succeeded", expected_head_sha, reruns)
            if classification is CIClassification.RUNNING:
                elapsed = self.clock.monotonic() - started
                if elapsed >= self.deadline_seconds:
                    return timeout_result()
                self.clock.sleep(min(self.poll_seconds, self.deadline_seconds - elapsed))
                continue
            if classification is CIClassification.TRANSIENT and reruns < self.max_reruns:
                if over_deadline():
                    return timeout_result()
                try:
                    gate.require_write("rerun-ci")
                except WriteDenied:
                    return CIResult(CIClassification.WRITE_NOT_AUTHORIZED, "transient CI cannot be rerun in audit-only mode", expected_head_sha, reruns)
                try:
                    rerun(observation)
                except Exception as exc:
                    if over_deadline():
                        return timeout_result()
                    return CIResult(CIClassification.EXTERNAL_UNKNOWN, f"rerun-error:{type(exc).__name__}", expected_head_sha, reruns)
                reruns += 1
                if over_deadline():
                    return timeout_result()
                continue
            if classification is CIClassification.TRANSIENT:
                if over_deadline():
                    return timeout_result()
                return CIResult(classification, "transient failure after rerun limit", expected_head_sha, reruns)
            if over_deadline():
                return timeout_result()
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
    pr_number: int = 0
    run_id: int = 0
    parent_sha: str = ""
    author_login: str = ""
    committer_login: str = ""
    verification_verified: bool = False
    parents: tuple[str, ...] = ()
    created_by_skill: bool = False
    author_type: str | None = None
    committer_type: str | None = None


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
        self.repair_chain: list[RepairCommitRecord] = []
        self.repair_provenance: list[RepairProvenanceRecord] = []

    def run(
        self,
        *,
        pr_number: int,
        run_id: int,
        initial_head_sha: str,
        current_head: Callable[[], str],
        diagnose: Callable[[int, str], RepairDiagnosis],
        create_commit: Callable[[RepairDiagnosis, str, str], FixCommit],
        push: Callable[[str, FixCommit], None],
        wait_for_ci: Callable[[str], CIResult],
        record_provenance: Callable[[RepairCommitRecord], RepairProvenanceRecord] | None = None,
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
            try:
                marker = make_fix_marker(pr_number, head_sha, run_id)
            except ValueError:
                return RepairCycleResult("open", cycle - 1, tuple(commits), "invalid-repair-context", head_sha)
            try:
                commit = create_commit(
                    diagnosis,
                    marker,
                    make_fix_commit_message(diagnosis.summary, marker),
                )
            except Exception as exc:
                return RepairCycleResult(
                    "open",
                    cycle - 1,
                    tuple(commits),
                    f"fix-commit-failed:{type(exc).__name__}",
                    head_sha,
                )
            if (
                not SHA_RE.fullmatch(commit.sha)
                or commit.pr_number != pr_number
                or commit.run_id != run_id
                or commit.parent_sha != head_sha
                or commit.parents != (head_sha,)
                or commit.author_login not in DEFAULT_FIX_ACTORS
                or commit.committer_login != commit.author_login
                or not commit.created_by_skill
                or not _valid_repair_actor_shape(
                    commit.author_login,
                    commit.author_type,
                    commit.committer_type,
                    commit.verification_verified,
                    set(DEFAULT_FIX_ACTORS),
                )
                or not is_valid_fix_marker(
                    commit.marker,
                    pr_number,
                    source_head_sha=head_sha,
                    run_id=run_id,
                )
                or commit.marker != marker
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
            repair_record = RepairCommitRecord(
                pr_number,
                run_id,
                head_sha,
                commit.sha,
                commit.marker,
                commit.author_login,
                commit.committer_login,
                commit.verification_verified,
                make_repair_provenance_marker(pr_number, run_id, head_sha, commit.sha),
            )
            if record_provenance is None:
                return RepairCycleResult("open", cycle, tuple(commits), "repair-provenance-unavailable", commit.sha)
            try:
                self.gate.require_write("record-repair-provenance")
                provenance = record_provenance(repair_record)
            except Exception as exc:
                return RepairCycleResult("open", cycle, tuple(commits), f"repair-provenance-failed:{type(exc).__name__}", commit.sha)
            if (
                provenance.source != "github-state"
                or provenance.record_id < 1
                or provenance.marker != repair_record.provenance_marker
                or provenance.pr_number != repair_record.pr_number
                or provenance.run_id != repair_record.run_id
                or provenance.parent_sha != repair_record.parent_sha
                or provenance.commit_sha != repair_record.commit_sha
                or provenance.actor != repair_record.author_login
                or provenance.source_author_login != repair_record.author_login
                or provenance.source_author_type is None
                or provenance.source_author_type.casefold()
                != ("bot" if repair_record.author_login.endswith("[bot]") else "user")
                or provenance.body != build_repair_provenance_body(repair_record)
            ):
                return RepairCycleResult("open", cycle, tuple(commits), "repair-provenance-invalid", commit.sha)
            self.repair_chain.append(repair_record)
            self.repair_provenance.append(provenance)
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
        evidence: Iterable[CandidateEvidence],
        *,
        refetch: Callable[[int], PullRequestSnapshot],
        ci_success_for_head: Callable[[str], bool],
        merge: Callable[[str], str],
        wait_for_cd: Callable[[str], bool],
        update_branch: Callable[[int, str, str], PullRequestSnapshot] | None = None,
        rebuild_snapshot: Callable[[PullRequestSnapshot], PullRequestSnapshot] | None = None,
        revalidate: Callable[[PullRequestSnapshot], CandidateEvidence | None] | None = None,
    ) -> tuple[MergeResult, ...]:
        results: list[MergeResult] = []

        def refresh_base(
            expected_evidence: CandidateEvidence,
            current: PullRequestSnapshot,
        ) -> CandidateEvidence | None:
            expected = expected_evidence.pr
            if current.head_sha != expected.head_sha:
                return None
            if current.base_sha == expected.base_sha:
                return expected_evidence if expected_evidence.matches(current) else None
            if update_branch is None or revalidate is None:
                return None
            # Refetch immediately before the fixed expected-head mutation so
            # a changed head/base cannot be hidden by a stale diagnosis read.
            before_update = refetch(expected.number)
            if before_update.head_sha != expected.head_sha or before_update.base_sha != current.base_sha:
                return None
            try:
                self.gate.require_write("update-branch")
                updated = update_branch(
                    expected.number,
                    before_update.head_sha,
                    before_update.base_sha,
                )
            except (WriteDenied, SnapshotDrift):
                return None
            except Exception:
                return None
            if (
                updated.number != expected.number
                or updated.base_sha != before_update.base_sha
                or updated.head_sha == expected.head_sha
                or not updated.is_open()
            ):
                return None
            # The returned object is only a mutation response.  Rebuild it
            # from the live snapshot, discard all old local/CI evidence, and
            # run the complete validation adapter against the new pair.
            rebuilt = rebuild_snapshot(updated) if rebuild_snapshot else refetch(expected.number)
            if rebuilt.number != updated.number or rebuilt.head_sha != updated.head_sha or rebuilt.base_sha != updated.base_sha:
                return None
            rebuilt_evidence = revalidate(rebuilt)
            if not isinstance(rebuilt_evidence, CandidateEvidence) or not rebuilt_evidence.matches(rebuilt):
                return None
            return rebuilt_evidence

        ordered = tuple(evidence)
        for initial_evidence in sorted(ordered, key=lambda item: item.pr.number):
            expected = initial_evidence.pr
            if not initial_evidence.matches(expected):
                results.append(MergeResult(expected.number, Status.OPEN.value, "evidence-invalid"))
                continue
            if not self.gate.can_write():
                results.append(MergeResult(expected.number, Status.OPEN.value, "write-not-authorized"))
                continue
            current = refetch(expected.number)
            working_evidence = refresh_base(initial_evidence, current)
            if working_evidence is None:
                reason = "head SHA changed" if current.head_sha != expected.head_sha else "base-freshness-update-failed"
                results.append(MergeResult(expected.number, Status.OPEN.value, reason))
                continue
            working = working_evidence.pr
            if working.mergeable not in {"MERGEABLE", "mergeable"}:
                results.append(MergeResult(expected.number, Status.OPEN.value, "merge-conflict"))
                continue
            refreshed_during_merge = False
            ready_to_merge = False
            while True:
                if not ci_success_for_head(working.head_sha):
                    results.append(MergeResult(expected.number, Status.OPEN.value, "required-ci-not-success"))
                    break
                # The read here is immediately before the expected-SHA
                # mutation.  A base advance triggers a fresh branch update,
                # not a merge using stale local or CI evidence.
                latest = refetch(expected.number)
                if latest.head_sha == working.head_sha and latest.base_sha == working.base_sha:
                    if not working_evidence.matches(latest):
                        results.append(MergeResult(expected.number, Status.OPEN.value, "evidence-drift"))
                        break
                    try:
                        self.gate.require_write("squash-merge")
                    except WriteDenied as exc:
                        results.append(MergeResult(expected.number, Status.OPEN.value, str(exc)))
                        break
                    ready_to_merge = True
                    break
                if latest.head_sha != working.head_sha:
                    results.append(MergeResult(expected.number, Status.OPEN.value, "head SHA changed"))
                    break
                next_evidence = refresh_base(working_evidence, latest)
                if next_evidence is None or refreshed_during_merge:
                    results.append(MergeResult(expected.number, Status.OPEN.value, "base-freshness-update-failed"))
                    break
                working_evidence = next_evidence
                working = working_evidence.pr
                refreshed_during_merge = True
            if not ready_to_merge:
                continue
            try:
                merge_sha = merge(working.head_sha)
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
            "unsupported-dependency-source:" in reason
            or reason.endswith("integrity-mismatch")
            or "unexpected-registry" in reason
            or "suspicious-lifecycle-script:" in reason
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
    repair_chain: Iterable[RepairCommitRecord] = (),
    repair_provenance: Iterable[RepairProvenanceRecord] = (),
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
            if marker
            and is_valid_fix_marker(marker, pr.number)
            and trusted_commit(
                commit,
                pr_number=pr.number,
                repair_chain=repair_chain,
                repair_provenance=repair_provenance,
            )
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
    check_urls: tuple[str, ...] = ()
    fix_commit: str | None = None
    issue_url: str | None = None
    remaining: str = ""


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


class BatchAdapter(Protocol):
    """Explicit live boundary consumed by :class:`BatchOrchestrator`.

    A production adapter must implement these methods with the existing GH
    skill and fixed fallback.  Tests provide an in-memory adapter; this module
    never discovers or shells out to a live GitHub client implicitly.
    """

    def read_pull_requests(self) -> Iterable[PullRequestSnapshot]: ...
    def read_repair_chain(self, pr: PullRequestSnapshot) -> Iterable[RepairCommitRecord]: ...
    def read_repair_provenance(self, pr: PullRequestSnapshot) -> Iterable[RepairProvenanceRecord]: ...
    def read_dependency_diff(self, pr: PullRequestSnapshot) -> ManifestLockDiff: ...
    def footprint(self, pr: PullRequestSnapshot, diff: ManifestLockDiff) -> FootprintedItem: ...
    def run_matrix_and_docker(self, pr: PullRequestSnapshot, changes: tuple[DependencyChange, ...]) -> bool: ...
    def observe_ci(self, pr: PullRequestSnapshot, expected_head_sha: str) -> CIObservation: ...
    def rerun_ci(self, pr: PullRequestSnapshot, observation: CIObservation, expected_head_sha: str) -> None: ...
    def repair_run_id(self, pr: PullRequestSnapshot) -> int: ...
    def diagnose_repair(self, pr: PullRequestSnapshot, cycle: int, head_sha: str) -> RepairDiagnosis: ...
    def create_fix_commit(self, pr: PullRequestSnapshot, diagnosis: RepairDiagnosis, marker: str, message: str) -> FixCommit: ...
    def push_fix(self, pr: PullRequestSnapshot, expected_head_sha: str, commit: FixCommit) -> None: ...
    def record_repair_provenance(self, pr: PullRequestSnapshot, record: RepairCommitRecord) -> RepairProvenanceRecord: ...
    def read_current_pr(self, number: int) -> PullRequestSnapshot: ...
    def update_branch(self, number: int, expected_head_sha: str, expected_base_sha: str) -> PullRequestSnapshot: ...
    def rebuild_snapshot(self, pr: PullRequestSnapshot) -> PullRequestSnapshot: ...
    def ci_success_for_head(self, head_sha: str) -> bool: ...
    def merge_pr(self, number: int, expected_head_sha: str) -> str: ...
    def wait_for_cd(self, merge_sha: str) -> bool: ...
    def read_comments(self, number: int) -> Iterable[CommentRecord]: ...
    def create_comment(self, number: int, body: str) -> CommentRecord: ...
    def update_comment(self, comment_id: int, body: str) -> CommentRecord: ...
    def read_followup_issues(self) -> Iterable[IssueRecord]: ...
    def create_followup_issue(self, body: str) -> IssueRecord: ...
    def update_followup_issue(self, number: int, body: str) -> IssueRecord: ...
    def close_pr(self, number: int, expected_head_sha: str) -> None: ...
    def check_urls(self, pr: PullRequestSnapshot) -> Iterable[str]: ...


@dataclass(frozen=True)
class OrchestrationCandidate:
    pr: PullRequestSnapshot
    diff: ManifestLockDiff
    changes: tuple[DependencyChange, ...]
    preflight: GroupedPreflightResult
    footprint: FootprintedItem
    evidence: CandidateEvidence | None = None


@dataclass(frozen=True)
class BatchExecutionResult:
    status: str
    authorization: AuthorizationDecision
    reports: tuple[CandidateReport, ...]
    merge_results: tuple[MergeResult, ...]
    audit_markdown: str
    events: tuple[str, ...]


def make_grouped_idempotency_marker(
    project: str,
    changes: Iterable[DependencyChange],
) -> str:
    canonical = [
        {
            "package": change.package,
            "from": change.from_version,
            "to": change.to_version,
            "integrity": change.expected_integrity or "",
        }
        for change in sorted(changes, key=lambda item: item.package)
    ]
    digest = hashlib.sha256(
        json.dumps([project, canonical], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:32]
    return f"dependabot-batch:v1:{digest}"


class BatchOrchestrator:
    """Executable state machine for one deterministic, injectable batch.

    The ordering is deliberately two-phase: all selected candidates must pass
    complete grouped static preflight before any local dependency execution;
    only then are footprint waves, Docker/matrix, CI, bounded repair, marker
    writes, disposition, and serial merge/CD adapters called.
    """

    def __init__(
        self,
        adapter: BatchAdapter,
        *,
        preflight: SupplyChainPreflight | None = None,
        ci_waiter: CIWaiter | None = None,
        required_label: str = REQUIRED_LABEL,
    ) -> None:
        self.adapter = adapter
        self.preflight = preflight or SupplyChainPreflight()
        self.ci_waiter = ci_waiter or CIWaiter()
        self.required_label = required_label
        self.events: list[str] = []

    class _IssueWriter:
        def __init__(self, adapter: BatchAdapter) -> None:
            self.adapter = adapter

        def create(self, body: str) -> IssueRecord:
            return self.adapter.create_followup_issue(body)

        def update(self, number: int, body: str) -> IssueRecord:
            return self.adapter.update_followup_issue(number, body)

    def _comment_writer(
        self,
        gate: MutationGate,
        pr: PullRequestSnapshot,
        marker: str,
        body: str,
        comments: tuple[CommentRecord, ...],
    ) -> Callable[[str], Any]:
        def write(_: str) -> Any:
            mutation = plan_idempotent_comment(marker, body, comments)
            if mutation.action == "create":
                gate.require_write("comment-create")
                self.events.append(f"comment-create:{pr.number}")
                return self.adapter.create_comment(pr.number, mutation.body)
            gate.require_write("comment-update")
            self.events.append(f"comment-update:{pr.number}")
            return self.adapter.update_comment(mutation.comment_id or 0, mutation.body)

        return write

    def _ensure_open_comment(
        self,
        gate: MutationGate,
        pr: PullRequestSnapshot,
        marker: str,
        body: str,
        comments: tuple[CommentRecord, ...],
    ) -> bool:
        try:
            self._comment_writer(gate, pr, marker, body, comments)(body)
        except WriteDenied:
            return False
        except Exception:
            return False
        return True

    def _rebuild_candidate_evidence(
        self,
        pr: PullRequestSnapshot,
        gate: MutationGate,
    ) -> CandidateEvidence | None:
        """Rebuild every input/evidence stage from a freshly fetched PR."""

        chains = tuple(self.adapter.read_repair_chain(pr))
        provenance = tuple(self.adapter.read_repair_provenance(pr))
        if trust_reasons(
            pr,
            required_label=self.required_label,
            repair_chain=chains,
            repair_provenance=provenance,
        ):
            return None
        diff = self.adapter.read_dependency_diff(pr)
        reconstruction = reconstruct_grouped_changes(diff)
        grouped = self.preflight.check_grouped(
            reconstruction.changes,
            reconstruction_errors=reconstruction.errors,
        )
        if not grouped.complete:
            return None
        if not self.adapter.run_matrix_and_docker(pr, grouped.changes):
            return None
        ci_result = self.ci_waiter.wait(
            pr.head_sha,
            lambda head: self.adapter.observe_ci(pr, head),
            lambda observation: self.adapter.rerun_ci(pr, observation, pr.head_sha),
            gate=gate,
        )
        if ci_result.classification is not CIClassification.SUCCESS:
            return None
        return CandidateEvidence.create(
            pr,
            diff,
            grouped.changes,
            grouped,
            True,
            ci_result,
        )

    def _wait_for_repair_ci(
        self,
        number: int,
        head_sha: str,
        gate: MutationGate,
    ) -> CIResult:
        """Bind post-push CI observation to a freshly fetched repair head."""

        try:
            repaired = self.adapter.read_current_pr(number)
        except Exception as exc:
            return CIResult(
                CIClassification.EXTERNAL_UNKNOWN,
                f"repair-head-refetch-failed:{type(exc).__name__}",
                head_sha,
            )
        if repaired.head_sha.casefold() != head_sha.casefold():
            return CIResult(
                CIClassification.EXTERNAL_UNKNOWN,
                "repair-head-not-visible-or-drifted",
                head_sha,
            )
        return self.ci_waiter.wait(
            head_sha,
            lambda expected: self.adapter.observe_ci(repaired, expected),
            lambda observation: self.adapter.rerun_ci(
                repaired, observation, head_sha
            ),
            gate=gate,
        )

    def _record_failure_disposition(
        self,
        gate: MutationGate,
        *,
        pr: PullRequestSnapshot,
        project: str,
        changes: tuple[DependencyChange, ...],
        classification: str,
        reason: str,
        preflight: PreflightResult | None,
        audit_only: bool,
    ) -> tuple[str, str | None]:
        """Apply the fixed comment/Issue/close contract for one outcome."""

        if audit_only:
            return Status.OPEN.value, None
        marker = make_grouped_idempotency_marker(project, changes)
        comment_body = f"Dependabot batch処理結果: PR #{pr.number}\n判定: {reason}"
        comments = tuple(self.adapter.read_comments(pr.number))
        disposition = disposition_for(
            classification=classification,
            preflight=preflight,
        )
        status = Status.OPEN.value
        if disposition == "close":
            status = DispositionExecutor(gate).apply(
                pr,
                disposition="close",
                read_current=lambda: self.adapter.read_current_pr(pr.number),
                comment=self._comment_writer(gate, pr, marker, comment_body, comments),
                close=lambda expected_head: self.adapter.close_pr(pr.number, expected_head),
                comment_body=comment_body,
            )
        else:
            self._ensure_open_comment(gate, pr, marker, comment_body, comments)
        issue_url: str | None = None
        if status == Status.OPEN.value:
            first = changes[0] if changes else DependencyChange(project, "group", "", "", "unknown")
            issue_body = build_followup_issue_body(
                summary=comment_body,
                pr_url=pr.html_url,
                project=project,
                package=first.package,
                from_version=first.from_version,
                to_version=first.to_version,
                base_sha=pr.base_sha,
                head_sha=pr.head_sha,
                check_urls=getattr(self.adapter, "check_urls", lambda _: ()) (pr),
                classification=classification,
                attempts=(reason,),
                reproduction="固定adapterの再現手順を参照",
                recommendation="PRをopenのまま手動確認",
                close_reason="",
                marker=marker,
            )
            plan = FollowupIssueManager(gate).ensure(
                marker,
                issue_body,
                search_all=self.adapter.read_followup_issues,
                writer=self._IssueWriter(self.adapter),
            )
            if plan.issue is not None:
                issue_url = plan.issue.html_url
        return status, issue_url

    def run(
        self,
        *,
        current_turn_instruction: str | None,
        mode: Mode | str = Mode.WRITE,
        instruction_source: str = "current_turn_human",
    ) -> BatchExecutionResult:
        self.events = []
        requested_mode = Mode(mode)
        authorization = evaluate_authorization(
            current_turn_instruction,
            source=instruction_source,
            requested_mode=mode,
        )
        gate = MutationGate(authorization)
        bind_gate = getattr(self.adapter, "bind_gate", None)
        if callable(bind_gate):
            bind_gate(gate)
        self.events.append("authorization")
        prs = tuple(self.adapter.read_pull_requests())
        self.events.append("snapshot-read")
        repair_chains = {
            pr.number: tuple(self.adapter.read_repair_chain(pr))
            for pr in prs
        }
        repair_provenance = {
            pr.number: tuple(self.adapter.read_repair_provenance(pr))
            for pr in prs
        }
        selection = select_pull_requests(
            prs,
            required_label=self.required_label,
            repair_chains=repair_chains,
            repair_provenance=repair_provenance,
        )
        self.events.append("selector-trust")
        aggregator = AuditAggregator()
        reports: dict[int, CandidateReport] = {}
        for number, reasons in sorted(selection.rejected.items()):
            pr = next(item for item in prs if item.number == number)
            reports[number] = CandidateReport(number, Status.SKIPPED.value, ",".join(reasons))
        audit_only = authorization.mode is Mode.AUDIT_ONLY or not authorization.allows_write
        if requested_mode is Mode.WRITE and audit_only:
            self.events.append("write-denied-downgraded-to-audit-only")

        prepared: dict[int, OrchestrationCandidate] = {}
        for pr in selection.selected:
            try:
                diff = self.adapter.read_dependency_diff(pr)
                reconstruction = reconstruct_grouped_changes(diff)
                grouped = self.preflight.check_grouped(
                    reconstruction.changes,
                    reconstruction_errors=reconstruction.errors,
                )
                self.events.append(f"grouped-preflight:{pr.number}")
                if not grouped.complete:
                    reason = "grouped-preflight:" + ",".join(grouped.reasons)
                    synthetic_preflight = PreflightResult(grouped.status, grouped.reasons)
                    disposition_status, issue_url = self._record_failure_disposition(
                        gate,
                        pr=pr,
                        project=diff.project,
                        changes=grouped.changes,
                        classification="external/unknown",
                        reason=reason,
                        preflight=synthetic_preflight,
                        audit_only=audit_only,
                    )
                    reports[pr.number] = CandidateReport(
                        pr.number,
                        disposition_status,
                        reason,
                        grouped,
                        False,
                        tuple(getattr(self.adapter, "check_urls", lambda _: ()) (pr)),
                        None,
                        issue_url,
                    )
                    continue
                item = self.adapter.footprint(pr, diff)
                prepared[pr.number] = OrchestrationCandidate(
                    pr,
                    diff,
                    grouped.changes,
                    grouped,
                    item,
                )
            except Exception as exc:
                reason = f"grouped-preflight-error:{type(exc).__name__}"
                reports[pr.number] = CandidateReport(
                    pr.number,
                    Status.OPEN.value,
                    reason,
                    check_urls=tuple(getattr(self.adapter, "check_urls", lambda _: ()) (pr)),
                )
        self.events.append("all-grouped-preflight-complete")
        merge_candidates: dict[int, CandidateEvidence] = {}
        if audit_only:
            for candidate in prepared.values():
                reason = "audit-only: no matrix/docker/ci/dependency execution"
                reports[candidate.pr.number] = CandidateReport(
                    candidate.pr.number,
                    Status.OPEN.value,
                    reason,
                    candidate.preflight,
                    False,
                )
        else:
            waves = schedule_footprints(candidate.footprint for candidate in prepared.values())
            self.events.append("footprint-waves")
            for wave in waves:
                eligible: list[OrchestrationCandidate] = []
                for item in sorted(wave, key=lambda value: str(value.identifier)):
                    candidate = prepared[int(item.identifier)]
                    pr = candidate.pr
                    self.events.append(f"snapshot-recheck:{pr.number}")
                    try:
                        assert_expected_snapshot(pr, self.adapter.read_current_pr(pr.number))
                    except SnapshotDrift as exc:
                        reports[pr.number] = CandidateReport(
                            pr.number,
                            Status.OPEN.value,
                            str(exc),
                            candidate.preflight,
                            False,
                        )
                        continue
                    eligible.append(candidate)
                local_results: dict[int, tuple[bool, str]] = {}
                if eligible:
                    # Independent footprint work is the only concurrent part;
                    # all GH writes and the merge/CD phase remain serial.
                    with ThreadPoolExecutor(max_workers=min(2, len(eligible))) as executor:
                        futures = {
                            executor.submit(
                                self.adapter.run_matrix_and_docker,
                                candidate.pr,
                                candidate.changes,
                            ): candidate.pr.number
                            for candidate in eligible
                        }
                        for future in as_completed(futures):
                            number = futures[future]
                            try:
                                local_ok = bool(future.result())
                                local_results[number] = (
                                    local_ok,
                                    "local-verification-passed" if local_ok else "local-verification-failed",
                                )
                            except Exception as exc:
                                local_results[number] = (False, f"matrix-docker-error:{type(exc).__name__}")
                for item in wave:
                    candidate = prepared[int(item.identifier)]
                    pr = candidate.pr
                    if pr.number not in local_results:
                        continue
                    self.events.append(f"matrix-docker:{pr.number}")
                    local_ok, local_reason = local_results[pr.number]
                    if not local_ok:
                        disposition_status, issue_url = self._record_failure_disposition(
                            gate,
                            pr=pr,
                            project=candidate.diff.project,
                            changes=candidate.changes,
                            classification="external/unknown",
                            reason=local_reason,
                            preflight=None,
                            audit_only=audit_only,
                        )
                        reports[pr.number] = CandidateReport(
                            pr.number,
                            disposition_status,
                            local_reason,
                            candidate.preflight,
                            True,
                            tuple(getattr(self.adapter, "check_urls", lambda _: ()) (pr)),
                            None,
                            issue_url,
                        )
                        continue
                    self.events.append(f"ci-wait:{pr.number}")
                    ci_result = self.ci_waiter.wait(
                        pr.head_sha,
                        lambda head, pr=pr: self.adapter.observe_ci(pr, head),
                        lambda observation, pr=pr: self.adapter.rerun_ci(pr, observation, pr.head_sha),
                        gate=gate,
                    )
                    final_head = pr.head_sha
                    fix_commit_sha: str | None = None
                    if ci_result.classification is CIClassification.DEPENDENCY_CAUSED:
                        self.events.append(f"repair:{pr.number}")
                        controller = RepairCycleController(gate)
                        repair = controller.run(
                            pr_number=pr.number,
                            run_id=self.adapter.repair_run_id(pr),
                            initial_head_sha=pr.head_sha,
                            current_head=lambda pr=pr: self.adapter.read_current_pr(pr.number).head_sha,
                            diagnose=lambda cycle, head, pr=pr: self.adapter.diagnose_repair(pr, cycle, head),
                            create_commit=lambda diagnosis, marker, message, pr=pr: self.adapter.create_fix_commit(pr, diagnosis, marker, message),
                            push=lambda old_head, commit, pr=pr: self.adapter.push_fix(pr, old_head, commit),
                            wait_for_ci=lambda head, number=pr.number: self._wait_for_repair_ci(
                                number, head, gate
                            ),
                            record_provenance=lambda record, pr=pr: self.adapter.record_repair_provenance(pr, record),
                        )
                        final_head = repair.final_head_sha
                        if repair.commits:
                            fix_commit_sha = repair.commits[-1].sha
                        if repair.status == Status.SUCCESS.value:
                            repaired_pr = self.adapter.read_current_pr(pr.number)
                            rebuilt_evidence = self._rebuild_candidate_evidence(repaired_pr, gate)
                            if rebuilt_evidence is None:
                                ci_result = CIResult(
                                    CIClassification.EXTERNAL_UNKNOWN,
                                    "repair-evidence-rebuild-failed",
                                    final_head,
                                    ci_result.reruns,
                                )
                            else:
                                ci_result = rebuilt_evidence.ci_result
                                candidate = OrchestrationCandidate(
                                    repaired_pr,
                                    rebuilt_evidence.diff,
                                    rebuilt_evidence.changes,
                                    rebuilt_evidence.preflight,
                                    candidate.footprint,
                                    rebuilt_evidence,
                                )
                                prepared[pr.number] = candidate
                                pr = repaired_pr
                        else:
                            ci_result = CIResult(CIClassification.DEPENDENCY_CAUSED, repair.reason, final_head, ci_result.reruns)
                    if ci_result.classification is CIClassification.SUCCESS:
                        reports[pr.number] = CandidateReport(
                            pr.number,
                            Status.SUCCESS.value,
                            "verification-passed",
                            candidate.preflight,
                            True,
                            tuple(getattr(self.adapter, "check_urls", lambda _: ()) (pr)),
                            fix_commit_sha,
                        )
                        evidence = candidate.evidence or CandidateEvidence.create(
                            pr,
                            candidate.diff,
                            candidate.changes,
                            candidate.preflight,
                            True,
                            ci_result,
                        )
                        merge_candidates[pr.number] = evidence
                        marker = make_grouped_idempotency_marker(candidate.diff.project, candidate.changes)
                        self._ensure_open_comment(
                            gate,
                            pr,
                            marker,
                            f"Dependabot batch処理結果: PR #{pr.number}\n判定: verification-passed",
                            tuple(self.adapter.read_comments(pr.number)),
                        )
                    else:
                        reason = f"ci:{ci_result.classification.value}:{ci_result.reason}"
                        disposition_status, issue_url = self._record_failure_disposition(
                            gate,
                            pr=pr,
                            project=candidate.diff.project,
                            changes=candidate.changes,
                            classification=ci_result.classification.value,
                            reason=reason,
                            preflight=None,
                            audit_only=audit_only,
                        )
                        reports[pr.number] = CandidateReport(
                            pr.number,
                            disposition_status,
                            reason,
                            candidate.preflight,
                            True,
                            tuple(getattr(self.adapter, "check_urls", lambda _: ()) (pr)),
                            fix_commit_sha,
                            issue_url,
                        )
        self.events.append("serial-merge-cd")
        merge_results: tuple[MergeResult, ...] = ()
        if merge_candidates and authorization.allows_write:
            def merge_by_head(head_sha: str) -> str:
                for number in sorted(merge_candidates):
                    current = self.adapter.read_current_pr(number)
                    if current.head_sha == head_sha:
                        return self.adapter.merge_pr(number, head_sha)
                raise SnapshotDrift("merge head does not belong to a candidate")

            merge_results = SerialMerger(gate).merge_in_order(
                tuple(merge_candidates.values()),
                refetch=self.adapter.read_current_pr,
                ci_success_for_head=self.adapter.ci_success_for_head,
                merge=merge_by_head,
                wait_for_cd=self.adapter.wait_for_cd,
                update_branch=self.adapter.update_branch,
                rebuild_snapshot=self.adapter.rebuild_snapshot,
                revalidate=lambda updated: self._rebuild_candidate_evidence(updated, gate),
            )
        for result in merge_results:
            if result.pr_number in reports:
                previous = reports[result.pr_number]
                reports[result.pr_number] = CandidateReport(
                    result.pr_number,
                    result.status,
                    result.reason,
                    previous.preflight,
                    previous.verification_ran,
                )
        by_number = {pr.number: pr for pr in prs}
        for number, report in reports.items():
            pr = by_number.get(number)
            if pr is None:
                continue
            check_urls = report.check_urls or tuple(getattr(self.adapter, "check_urls", lambda _: ()) (pr))
            aggregator.add(
                AuditRecord(
                    number,
                    pr.html_url,
                    pr.base_sha,
                    pr.head_sha,
                    report.status,
                    report.reason,
                    check_urls=check_urls,
                    fix_commit=report.fix_commit,
                    mutation_result=report.status,
                    issue_url=report.issue_url,
                    remaining=report.remaining,
                )
            )
        return BatchExecutionResult(
            "completed",
            authorization,
            tuple(reports[number] for number in sorted(reports)),
            merge_results,
            aggregator.render_markdown(),
            tuple(self.events),
        )


def execute_batch(
    adapter: BatchAdapter,
    *,
    current_turn_instruction: str | None,
    mode: Mode | str = Mode.WRITE,
    instruction_source: str = "current_turn_human",
    preflight: SupplyChainPreflight | None = None,
    ci_waiter: CIWaiter | None = None,
) -> BatchExecutionResult:
    """Public executable entry point for a fully injected adapter."""

    return BatchOrchestrator(
        adapter,
        preflight=preflight,
        ci_waiter=ci_waiter,
    ).run(
        current_turn_instruction=current_turn_instruction,
        mode=mode,
        instruction_source=instruction_source,
    )


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
    parser.add_argument("--snapshot", type=Path, help="read-only GitHub snapshot JSON")
    parser.add_argument("--live", action="store_true", help="use the concrete GH/process adapter")
    parser.add_argument("--owner", default="u7chan")
    parser.add_argument("--repository", default="monorepo")
    parser.add_argument("--mode", choices=[mode.value for mode in Mode], default=Mode.AUDIT_ONLY.value)
    parser.add_argument("--instruction-source", default="current_turn_human")
    parser.add_argument("--current-turn-instruction")
    parser.add_argument("--default-branch", default=DEFAULT_BRANCH)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    requested_mode = Mode(args.mode)
    authorization = evaluate_authorization(
        args.current_turn_instruction,
        source=args.instruction_source,
        requested_mode=requested_mode,
    )
    if args.live:
        from concrete_adapter import ConcreteBatchAdapter, GhSkillProcessDispatcher

        dispatcher = GhSkillProcessDispatcher(
            Path("/home/u7dev/.agents/skills/agent-harness/gh/scripts/gh.sh"),
            cwd=Path.cwd(),
        )
        adapter = ConcreteBatchAdapter(
            owner=args.owner,
            repository=args.repository,
            dispatcher=dispatcher,
            repository_root=Path.cwd(),
        )
        result = execute_batch(
            adapter,
            current_turn_instruction=args.current_turn_instruction,
            mode=requested_mode,
            instruction_source=args.instruction_source,
        )
        print(f"mode={result.authorization.mode.value} status={result.status}")
        print(result.audit_markdown)
        return 0 if result.status == "completed" else 2
    if args.snapshot is None:
        print("mode=blocked reason=--snapshot is required without --live")
        return 2
    prs = load_snapshot(args.snapshot)
    if requested_mode is Mode.WRITE:
        if not authorization.allows_write:
            report = build_audit_snapshot_report(prs, default_branch=args.default_branch)
            print(f"mode=audit-only reason={authorization.reason}")
            print(report.render_markdown())
            return 0
        print(
            "mode=blocked reason=write mode requires an explicitly injected BatchAdapter; "
            "the snapshot CLI will not guess a live writer",
        )
        return 2
    report = build_audit_snapshot_report(prs, default_branch=args.default_branch)
    print(f"mode={authorization.mode.value} reason={authorization.reason}")
    print(report.render_markdown())
    # This command intentionally stops at a report.  Live mutation adapters
    # are separate and must call MutationGate; a write request cannot turn a
    # snapshot-report command into a GitHub writer by accident.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
