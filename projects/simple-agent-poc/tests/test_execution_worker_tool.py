"""Tests for execution-worker tool wiring."""

import json

import pytest

from simple_agent_poc.adapters.execution_worker.client import (
    WorkerError,
    WorkerExecutionResult,
)
from simple_agent_poc.adapters.tools.execute_javascript import create_execute
from simple_agent_poc.entrypoints.bootstrap import (
    create_default_tool_executor,
    resolve_execution_worker_config,
)


class StubExecutionWorkerClient:
    def __init__(self, result: WorkerExecutionResult) -> None:
        self.result = result
        self.calls = []

    def execute_javascript(self, **kwargs):
        self.calls.append(kwargs)
        return self.result


def test_execute_javascript_tool_serializes_success_result() -> None:
    client = StubExecutionWorkerClient(
        WorkerExecutionResult(
            status="success",
            stdout="run\n",
            result=6,
            duration_ms=3,
            applied_timeout_ms=1000,
        )
    )
    execute = create_execute(client)

    payload = json.loads(
        execute(
            {
                "code": "async function main(input) { return input.value }",
                "input": {"value": 6},
                "timeout_ms": 1000,
            }
        )
    )

    assert payload["status"] == "success"
    assert payload["result"] == 6
    assert client.calls == [
        {
            "code": "async function main(input) { return input.value }",
            "input_data": {"value": 6},
            "timeout_ms": 1000,
        }
    ]


def test_execute_javascript_tool_serializes_worker_error() -> None:
    client = StubExecutionWorkerClient(
        WorkerExecutionResult(
            status="error",
            error=WorkerError(
                category="validation",
                code="VALIDATION_ERROR",
                message="Invalid request",
                http_status=400,
                details=["code must be a string"],
            ),
        )
    )
    execute = create_execute(client)

    payload = json.loads(execute({"code": ""}))

    assert payload["status"] == "error"
    assert payload["error"]["category"] == "validation"
    assert payload["error"]["code"] == "VALIDATION_ERROR"
    assert payload["error"]["details"] == ["code must be a string"]


def test_resolve_execution_worker_config_returns_none_without_url() -> None:
    assert resolve_execution_worker_config({}) is None


def test_resolve_execution_worker_config_uses_url_and_timeout() -> None:
    config = resolve_execution_worker_config(
        {
            "EXECUTION_WORKER_URL": "http://worker.local",
            "EXECUTION_WORKER_TIMEOUT_MS": "2500",
        }
    )

    assert config is not None
    assert config.base_url == "http://worker.local"
    assert config.timeout_seconds == 2.5


def test_resolve_execution_worker_config_rejects_invalid_timeout() -> None:
    with pytest.raises(ValueError, match="must be an integer"):
        resolve_execution_worker_config(
            {
                "EXECUTION_WORKER_URL": "http://worker.local",
                "EXECUTION_WORKER_TIMEOUT_MS": "invalid",
            }
        )


def test_create_default_tool_executor_registers_execute_javascript_when_configured(
    monkeypatch,
) -> None:
    monkeypatch.setenv("EXECUTION_WORKER_URL", "http://worker.local")

    registry = create_default_tool_executor()
    definitions = registry.get_definitions(["execute_javascript"])

    assert len(definitions) == 1
    assert definitions[0]["function"]["name"] == "execute_javascript"
