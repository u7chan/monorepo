#!/usr/bin/env python3
"""Narrow GitHub boundary for operations missing from the repository GH skill.

Reads should normally be dispatched through the existing GH skill actions.  The
fallback here is intentionally not a generic ``gh api`` wrapper: callers pick
one of a fixed operation names, endpoints are constructed from validated
owner/repository/IDs, arguments are an array, and every response is parsed as
JSON before it is returned.  Mutation operations require the caller's
``MutationGate`` (duck-typed to avoid an import cycle).
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence


SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")


class BoundaryError(ValueError):
    pass


class FixedOperation(str, Enum):
    READ_CHECK_RUNS = "read-check-runs"
    READ_WORKFLOW_RUN = "read-workflow-run"
    READ_WORKFLOW_JOBS = "read-workflow-jobs"
    RERUN_FAILED_JOBS = "rerun-failed-jobs"
    MERGE_PULL_REQUEST = "merge-pull-request"


MUTATING_OPERATIONS = frozenset(
    {FixedOperation.RERUN_FAILED_JOBS, FixedOperation.MERGE_PULL_REQUEST}
)


class MutationAuthorizer(Protocol):
    def require_write(self, operation: str) -> None:
        ...


@dataclass(frozen=True)
class ApiRequest:
    operation: FixedOperation
    argv: tuple[str, ...]
    stdin_json: str | None
    endpoint: str


@dataclass(frozen=True)
class ApiResponse:
    status_code: int
    payload: Mapping[str, Any]


class GhSkillDispatcher(Protocol):
    def __call__(self, action: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        ...


# These are the existing actions that this skill should prefer.  The list is
# documentation and an allowlist for the adapter; it is not a second GH
# implementation.
EXISTING_GH_READ_ACTIONS = frozenset(
    {
        "repo.get",
        "issue.get",
        "issue.list",
        "prs.list",
        "prs.search",
        "pr.read",
        "pr.files.read",
        "pr.commits.read",
        "pr.checks.read",
        "comments.read",
        "reviews.read",
        "review-comments.read",
        "review-threads.read",
    }
)
EXISTING_GH_WRITE_ACTIONS = frozenset(
    {
        "comments.create",
        "comments.update",
        "issue.create",
        "issue.update",
        "issue.close",
        "pr.close",
    }
)


class ExistingGhSkillClient:
    """Validate and dispatch an action through the common GH skill."""

    def __init__(self, dispatcher: GhSkillDispatcher) -> None:
        self.dispatcher = dispatcher

    def read(self, action: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        if action not in EXISTING_GH_READ_ACTIONS:
            raise BoundaryError(f"action is not an existing read action: {action}")
        return self.dispatcher(action, payload)

    def write(
        self,
        action: str,
        payload: Mapping[str, Any],
        *,
        gate: MutationAuthorizer,
    ) -> Mapping[str, Any]:
        if action not in EXISTING_GH_WRITE_ACTIONS:
            raise BoundaryError(f"action is not an existing write action: {action}")
        gate.require_write(f"gh:{action}")
        return self.dispatcher(action, payload)


def _validated_identifier(value: str, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise BoundaryError(f"invalid {label}")
    return value


def _validated_number(value: int, label: str) -> int:
    if not isinstance(value, int) or value < 1:
        raise BoundaryError(f"invalid {label}")
    return value


def _validated_sha(value: str, label: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise BoundaryError(f"invalid {label}")
    return value.lower()


class FixedGhApi:
    """Build and execute only the five documented fallback operations."""

    def __init__(
        self,
        owner: str,
        repository: str,
        *,
        runner: "GhCommandRunner | None" = None,
        cwd: Path | None = None,
        api_timeout_seconds: int = 60,
    ) -> None:
        self.owner = _validated_identifier(owner, OWNER_RE, "owner")
        self.repository = _validated_identifier(repository, REPO_RE, "repository")
        self.runner = runner or SubprocessGhCommandRunner()
        self.cwd = cwd or Path.cwd()
        if api_timeout_seconds <= 0:
            raise BoundaryError("GitHub API timeout must be positive")
        self.api_timeout_seconds = api_timeout_seconds

    def _endpoint(self, suffix: str) -> str:
        # suffix is selected internally and never accepted from a caller.
        return f"/repos/{self.owner}/{self.repository}{suffix}"

    def build_request(self, operation: FixedOperation, **kwargs: Any) -> ApiRequest:
        try:
            operation = FixedOperation(operation)
        except ValueError as exc:
            raise BoundaryError("unsupported fixed operation") from exc
        if operation is FixedOperation.READ_CHECK_RUNS:
            sha = _validated_sha(kwargs.get("expected_head_sha"), "expected head SHA")
            endpoint = self._endpoint(f"/commits/{sha}/check-runs")
            return self._request(operation, endpoint, "GET")
        if operation is FixedOperation.READ_WORKFLOW_RUN:
            run_id = _validated_number(kwargs.get("run_id"), "workflow run ID")
            endpoint = self._endpoint(f"/actions/runs/{run_id}")
            return self._request(operation, endpoint, "GET")
        if operation is FixedOperation.READ_WORKFLOW_JOBS:
            run_id = _validated_number(kwargs.get("run_id"), "workflow run ID")
            endpoint = self._endpoint(f"/actions/runs/{run_id}/jobs")
            return self._request(operation, endpoint, "GET")
        if operation is FixedOperation.RERUN_FAILED_JOBS:
            run_id = _validated_number(kwargs.get("run_id"), "workflow run ID")
            _validated_sha(kwargs.get("expected_head_sha"), "expected head SHA")
            endpoint = self._endpoint(f"/actions/runs/{run_id}/rerun-failed-jobs")
            return self._request(operation, endpoint, "POST", {})
        if operation is FixedOperation.MERGE_PULL_REQUEST:
            number = _validated_number(kwargs.get("number"), "pull request number")
            expected = _validated_sha(kwargs.get("expected_head_sha"), "expected head SHA")
            endpoint = self._endpoint(f"/pulls/{number}/merge")
            return self._request(
                operation,
                endpoint,
                "PUT",
                {"merge_method": "squash", "sha": expected},
            )
        raise BoundaryError(f"unsupported fixed operation: {operation}")

    @staticmethod
    def _request(
        operation: FixedOperation,
        endpoint: str,
        method: str,
        body: Mapping[str, Any] | None = None,
    ) -> ApiRequest:
        if method not in {"GET", "POST", "PUT"}:
            raise BoundaryError("HTTP method is not allowlisted")
        argv: list[str] = [
            "gh",
            "api",
            "--hostname",
            "github.com",
            endpoint,
            "--method",
            method,
        ]
        stdin_json: str | None = None
        if body is not None:
            stdin_json = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
            argv.extend(("--input", "-"))
        return ApiRequest(operation, tuple(argv), stdin_json, endpoint)

    def execute(
        self,
        operation: FixedOperation,
        *,
        gate: MutationAuthorizer | None = None,
        **kwargs: Any,
    ) -> ApiResponse:
        try:
            operation = FixedOperation(operation)
        except ValueError as exc:
            raise BoundaryError("unsupported fixed operation") from exc
        if operation in MUTATING_OPERATIONS:
            if gate is None:
                raise BoundaryError("mutation operation requires MutationGate")
            gate.require_write(f"github-fallback:{operation.value}")
        request = self.build_request(operation, **kwargs)
        raw = self.runner.run(
            request.argv,
            stdin_json=request.stdin_json,
            cwd=self.cwd,
            timeout_seconds=self.api_timeout_seconds,
        )
        status_code, text = raw
        try:
            payload = json.loads(text)
        except (TypeError, json.JSONDecodeError) as exc:
            raise BoundaryError("GitHub fallback response was not JSON") from exc
        if not isinstance(payload, Mapping):
            raise BoundaryError("GitHub fallback response must be a JSON object")
        self._validate_response(operation, payload, kwargs)
        return ApiResponse(status_code, payload)

    @staticmethod
    def _validate_response(
        operation: FixedOperation,
        payload: Mapping[str, Any],
        kwargs: Mapping[str, Any],
    ) -> None:
        if operation is FixedOperation.READ_CHECK_RUNS:
            check_runs = payload.get("check_runs")
            if not isinstance(check_runs, list):
                raise BoundaryError("check-runs response lacks check_runs array")
            for check in check_runs:
                if not isinstance(check, Mapping):
                    raise BoundaryError("check-run entry is not an object")
                if not isinstance(check.get("id"), int) or not isinstance(check.get("name"), str):
                    raise BoundaryError("check-run entry lacks id/name")
                if not isinstance(check.get("status"), str):
                    raise BoundaryError("check-run entry lacks status")
                if check.get("conclusion") is not None and not isinstance(check.get("conclusion"), str):
                    raise BoundaryError("check-run conclusion is not a string or null")
            return
        if operation is FixedOperation.READ_WORKFLOW_RUN:
            if not isinstance(payload.get("id"), int) or not isinstance(payload.get("status"), str):
                raise BoundaryError("workflow run response lacks id/status")
            head_sha = payload.get("head_sha")
            if not isinstance(head_sha, str) or not SHA_RE.fullmatch(head_sha):
                raise BoundaryError("workflow run response lacks a valid head SHA")
            return
        if operation is FixedOperation.READ_WORKFLOW_JOBS:
            jobs = payload.get("jobs")
            if not isinstance(jobs, list):
                raise BoundaryError("workflow jobs response lacks jobs array")
            for job in jobs:
                if not isinstance(job, Mapping) or not isinstance(job.get("id"), int) or not isinstance(job.get("name"), str):
                    raise BoundaryError("workflow job entry lacks id/name")
            return
        if operation is FixedOperation.RERUN_FAILED_JOBS:
            # GitHub may return the run object or an empty object for this
            # endpoint.  Both are JSON-validated; no free-form message drives
            # a later action.
            if "head_sha" in payload:
                head_sha = payload.get("head_sha")
                expected = kwargs.get("expected_head_sha")
                if not isinstance(head_sha, str) or not SHA_RE.fullmatch(head_sha) or head_sha.casefold() != str(expected).casefold():
                    raise BoundaryError("rerun response head SHA does not match expected SHA")
            return
        if operation is FixedOperation.MERGE_PULL_REQUEST:
            if payload.get("merged") is not True:
                raise BoundaryError("merge response was not merged=true")
            if not isinstance(payload.get("sha"), str) or not SHA_RE.fullmatch(payload["sha"]):
                raise BoundaryError("merge response lacks merge SHA")
            if not isinstance(payload.get("message"), str):
                raise BoundaryError("merge response lacks message")
            # The expected head is validated before the request and encoded in
            # the body.  The response SHA is the new merge commit and is
            # therefore intentionally different from the head SHA.
            expected = kwargs.get("expected_head_sha")
            if not isinstance(expected, str) or not SHA_RE.fullmatch(expected):
                raise BoundaryError("merge request did not carry expected SHA")
            return
        raise BoundaryError("unvalidated operation response")


class GhCommandRunner(Protocol):
    def run(
        self,
        argv: Sequence[str],
        *,
        stdin_json: str | None,
        cwd: Path,
        timeout_seconds: int,
    ) -> tuple[int, str]:
        ...


class SubprocessGhCommandRunner:
    """Run a fixed argv with no shell and no caller-provided endpoint."""

    def run(
        self,
        argv: Sequence[str],
        *,
        stdin_json: str | None,
        cwd: Path,
        timeout_seconds: int,
    ) -> tuple[int, str]:
        if not argv or tuple(argv[:4]) != ("gh", "api", "--hostname", "github.com"):
            raise BoundaryError("unexpected gh argv prefix")
        if any(not isinstance(item, str) or not item for item in argv):
            raise BoundaryError("gh argv must be a string array")
        if any(item in {"--shell", "--jq", "--template"} for item in argv):
            raise BoundaryError("free-form gh output flags are forbidden")
        completed = subprocess.run(
            list(argv),
            cwd=cwd,
            input=stdin_json,
            text=True,
            capture_output=True,
            check=False,
            shell=False,
            timeout=timeout_seconds,
        )
        if completed.returncode != 0:
            raise BoundaryError(f"fixed gh operation failed with exit {completed.returncode}")
        return completed.returncode, completed.stdout
