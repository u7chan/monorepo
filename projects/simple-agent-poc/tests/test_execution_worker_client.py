"""Tests for execution-worker client mapping."""

import io
import json
from email.message import Message
from urllib.error import HTTPError, URLError
from urllib.request import Request

from simple_agent_poc.adapters.execution_worker.client import (
    ExecutionWorkerClient,
    ExecutionWorkerConfig,
)


class FakeResponse:
    def __init__(self, status: int, body: dict) -> None:
        self.status = status
        self._body = json.dumps(body).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None


def make_client(response_or_error) -> ExecutionWorkerClient:
    def opener(request: Request, *, timeout: float):
        assert request.full_url == "http://worker.local/execute"
        assert timeout == 2.5
        if isinstance(response_or_error, Exception):
            raise response_or_error
        return response_or_error

    return ExecutionWorkerClient(
        ExecutionWorkerConfig(
            base_url="http://worker.local/",
            timeout_seconds=2.5,
        ),
        opener=opener,
    )


def make_http_error(status: int, message: str, body: dict) -> HTTPError:
    return HTTPError(
        "http://worker.local/execute",
        status,
        message,
        Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def test_execute_javascript_maps_success_response() -> None:
    client = make_client(
        FakeResponse(
            200,
            {
                "status": "success",
                "stdout": "run\n",
                "stderr": "",
                "result": {"value": 6},
                "durationMs": 12,
                "appliedTimeoutMs": 1000,
            },
        )
    )

    result = client.execute_javascript(
        code="async function main(input) { return input.value }",
        input_data={"value": 6},
        timeout_ms=1000,
    )

    assert result.status == "success"
    assert result.stdout == "run\n"
    assert result.result == {"value": 6}
    assert result.duration_ms == 12
    assert result.applied_timeout_ms == 1000
    assert result.error is None


def test_execute_javascript_preserves_200_execution_error_code() -> None:
    client = make_client(
        FakeResponse(
            200,
            {
                "status": "error",
                "stdout": "",
                "stderr": "",
                "result": None,
                "durationMs": 4,
                "appliedTimeoutMs": 1000,
                "error": {
                    "code": "MAIN_FUNCTION_NOT_FOUND",
                    "message": "async function main(input) is required",
                },
            },
        )
    )

    result = client.execute_javascript(code="const value = 1")

    assert result.status == "error"
    assert result.error is not None
    assert result.error.category == "execution_error"
    assert result.error.code == "MAIN_FUNCTION_NOT_FOUND"
    assert result.error.http_status == 200


def test_execute_javascript_maps_timeout_category() -> None:
    client = make_client(
        FakeResponse(
            200,
            {
                "status": "error",
                "error": {
                    "code": "TIMEOUT",
                    "message": "Execution timed out",
                },
            },
        )
    )

    result = client.execute_javascript(code="async function main() {}")

    assert result.error is not None
    assert result.error.category == "timeout"
    assert result.error.code == "TIMEOUT"


def test_execute_javascript_maps_http_validation_error() -> None:
    error = make_http_error(
        400,
        "Bad Request",
        {
            "status": "error",
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Invalid request",
                "details": ["language must be javascript"],
            },
        },
    )
    client = make_client(error)

    result = client.execute_javascript(code="")

    assert result.error is not None
    assert result.error.category == "validation"
    assert result.error.code == "VALIDATION_ERROR"
    assert result.error.details == ["language must be javascript"]
    assert result.error.http_status == 400


def test_execute_javascript_maps_payload_too_large_error() -> None:
    error = make_http_error(
        413,
        "Payload Too Large",
        {
            "status": "error",
            "error": {
                "code": "PAYLOAD_TOO_LARGE",
                "message": "code or input exceeds the configured size limit",
            },
        },
    )
    client = make_client(error)

    result = client.execute_javascript(code="async function main() {}")

    assert result.error is not None
    assert result.error.category == "payload_too_large"
    assert result.error.code == "PAYLOAD_TOO_LARGE"
    assert result.error.http_status == 413


def test_execute_javascript_maps_concurrency_limit_error() -> None:
    error = make_http_error(
        429,
        "Too Many Requests",
        {
            "status": "error",
            "error": {
                "code": "CONCURRENCY_LIMIT_EXCEEDED",
                "message": "Too many concurrent executions",
                "limit": 2,
            },
        },
    )
    client = make_client(error)

    result = client.execute_javascript(code="async function main() {}")

    assert result.error is not None
    assert result.error.category == "concurrency_limit"
    assert result.error.code == "CONCURRENCY_LIMIT_EXCEEDED"
    assert result.error.limit == 2
    assert result.error.http_status == 429


def test_execute_javascript_maps_network_failure_as_upstream_unavailable() -> None:
    client = make_client(URLError("connection refused"))

    result = client.execute_javascript(code="async function main() {}")

    assert result.status == "error"
    assert result.error is not None
    assert result.error.category == "upstream_unavailable"
    assert result.error.code == "UPSTREAM_UNAVAILABLE"
