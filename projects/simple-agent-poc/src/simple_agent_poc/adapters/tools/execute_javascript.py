"""execute_javascript — runs JavaScript through execution-worker."""

import json
from collections.abc import Callable
from typing import Any, Protocol

from simple_agent_poc.adapters.execution_worker.client import WorkerExecutionResult
from simple_agent_poc.core.types import ToolDefinition

TOOL_DEFINITION: ToolDefinition = {
    "type": "function",
    "function": {
        "name": "execute_javascript",
        "description": "JavaScriptコードを隔離されたexecution-workerで実行します。",
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "async function main(input) を定義するJavaScriptコード",
                },
                "input": {
                    "description": "main(input) に渡すJSONシリアライズ可能な値",
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "実行タイムアウト（ミリ秒）",
                },
            },
            "required": ["code"],
        },
    },
}


class _ExecutionWorkerClient(Protocol):
    def execute_javascript(
        self,
        *,
        code: str,
        input_data: Any = None,
        timeout_ms: int | None = None,
    ) -> WorkerExecutionResult: ...


def create_execute(client: _ExecutionWorkerClient) -> Callable[[dict[str, Any]], str]:
    def execute(arguments: dict[str, Any]) -> str:
        timeout_ms = arguments.get("timeout_ms")
        result = client.execute_javascript(
            code=str(arguments.get("code", "")),
            input_data=arguments.get("input"),
            timeout_ms=timeout_ms if isinstance(timeout_ms, int) else None,
        )
        return json.dumps(_serialize_result(result), ensure_ascii=False)

    return execute


def _serialize_result(result) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": result.status,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "result": result.result,
        "duration_ms": result.duration_ms,
        "applied_timeout_ms": result.applied_timeout_ms,
    }
    if result.error is not None:
        payload["error"] = {
            "category": result.error.category,
            "code": result.error.code,
            "message": result.error.message,
            "http_status": result.error.http_status,
            "details": result.error.details,
            "limit": result.error.limit,
        }
    return payload
