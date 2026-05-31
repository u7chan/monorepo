"""HTTP client for the JavaScript execution-worker."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

WorkerErrorCategory = Literal[
    "validation",
    "payload_too_large",
    "concurrency_limit",
    "execution_error",
    "timeout",
    "upstream_unavailable",
]


class ExecuteRequestPayload(TypedDict, total=False):
    language: Literal["javascript"]
    code: str
    input: Any
    timeoutMs: int


@dataclass(frozen=True)
class ExecutionWorkerConfig:
    base_url: str
    timeout_seconds: float = 5.0

    def execute_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/execute"


@dataclass(frozen=True)
class WorkerError:
    category: WorkerErrorCategory
    code: str
    message: str
    http_status: int | None = None
    details: list[str] | None = None
    limit: int | None = None


@dataclass(frozen=True)
class WorkerExecutionResult:
    status: Literal["success", "error"]
    stdout: str = ""
    stderr: str = ""
    result: Any = None
    duration_ms: int | None = None
    applied_timeout_ms: int | None = None
    error: WorkerError | None = None


class _Response(Protocol):
    status: int

    def read(self) -> bytes: ...

    def __enter__(self) -> _Response: ...

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None: ...


_UrlOpen = Callable[..., _Response]


class ExecutionWorkerClient:
    """Call execution-worker and preserve its error contract."""

    def __init__(
        self,
        config: ExecutionWorkerConfig,
        *,
        opener: _UrlOpen = urlopen,
    ) -> None:
        self._config = config
        self._opener = opener

    def execute_javascript(
        self,
        *,
        code: str,
        input_data: Any = None,
        timeout_ms: int | None = None,
    ) -> WorkerExecutionResult:
        payload: ExecuteRequestPayload = {
            "language": "javascript",
            "code": code,
        }
        if input_data is not None:
            payload["input"] = input_data
        if timeout_ms is not None:
            payload["timeoutMs"] = timeout_ms

        request = Request(
            self._config.execute_url(),
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )

        try:
            with self._opener(
                request,
                timeout=self._config.timeout_seconds,
            ) as response:
                return self._map_response(response.status, response.read())
        except HTTPError as error:
            return self._map_response(error.code, error.read())
        except (TimeoutError, URLError, OSError) as error:
            return self._upstream_unavailable(str(error))

    def _map_response(self, http_status: int, body: bytes) -> WorkerExecutionResult:
        parsed = _parse_json_object(body)
        if parsed is None:
            return self._upstream_unavailable("execution-worker returned invalid JSON")

        if http_status == 200 and parsed.get("status") == "success":
            return WorkerExecutionResult(
                status="success",
                stdout=_string_value(parsed.get("stdout")),
                stderr=_string_value(parsed.get("stderr")),
                result=parsed.get("result"),
                duration_ms=_optional_int(parsed.get("durationMs")),
                applied_timeout_ms=_optional_int(parsed.get("appliedTimeoutMs")),
            )

        if parsed.get("status") == "error":
            error = _parse_worker_error(parsed.get("error"), http_status)
            return WorkerExecutionResult(
                status="error",
                stdout=_string_value(parsed.get("stdout")),
                stderr=_string_value(parsed.get("stderr")),
                result=parsed.get("result"),
                duration_ms=_optional_int(parsed.get("durationMs")),
                applied_timeout_ms=_optional_int(parsed.get("appliedTimeoutMs")),
                error=error,
            )

        return self._upstream_unavailable(
            f"execution-worker returned unexpected response status {http_status}"
        )

    @staticmethod
    def _upstream_unavailable(message: str) -> WorkerExecutionResult:
        return WorkerExecutionResult(
            status="error",
            error=WorkerError(
                category="upstream_unavailable",
                code="UPSTREAM_UNAVAILABLE",
                message=message,
            ),
        )


def _parse_json_object(body: bytes) -> dict[str, Any] | None:
    try:
        parsed = json.loads(body.decode("utf-8"))
    except UnicodeDecodeError, json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _parse_worker_error(error: object, http_status: int) -> WorkerError:
    if isinstance(error, dict):
        error_data = cast(dict[str, Any], error)
        code = _string_value(error_data.get("code")) or "WORKER_ERROR"
        message = _string_value(error_data.get("message")) or "execution-worker error"
        details_value = error_data.get("details")
        details = (
            [str(detail) for detail in details_value]
            if isinstance(details_value, list)
            else None
        )
        limit = _optional_int(error_data.get("limit"))
    else:
        code = "WORKER_ERROR"
        message = "execution-worker error"
        details = None
        limit = None

    return WorkerError(
        category=_category_for(http_status, code),
        code=code,
        message=message,
        http_status=http_status,
        details=details,
        limit=limit,
    )


def _category_for(http_status: int, code: str) -> WorkerErrorCategory:
    if http_status == 400:
        return "validation"
    if http_status == 413:
        return "payload_too_large"
    if http_status == 429:
        return "concurrency_limit"
    if code == "TIMEOUT":
        return "timeout"
    return "execution_error"


def _string_value(value: object) -> str:
    return value if isinstance(value, str) else ""


def _optional_int(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None
