"""Built-in tool registry — resolves tool names to definitions and executors."""

import json
from collections.abc import Callable
from typing import Any

from simple_agent_poc.application.ports import ToolExecutor
from simple_agent_poc.core.types import LLMError, ToolCall, ToolDefinition

_ExecuteFn = Callable[[dict[str, Any]], str]


class BuiltinToolRegistry(ToolExecutor):
    """Registry for built-in tools with definition + execute pairing."""

    def __init__(self) -> None:
        self._definitions: dict[str, ToolDefinition] = {}
        self._executors: dict[str, _ExecuteFn] = {}

    def register(
        self,
        definition: ToolDefinition,
        execute: _ExecuteFn,
    ) -> None:
        name = definition["function"]["name"]
        self._definitions[name] = definition
        self._executors[name] = execute

    def execute(self, tool_call: ToolCall, /) -> str:
        name = tool_call["function"]["name"]
        if name not in self._executors:
            raise LLMError(f"Unknown tool: {name}")
        executor = self._executors[name]
        arguments = json.loads(tool_call["function"]["arguments"])
        return executor(arguments)

    def get_definitions(self, tool_names: list[str], /) -> list[ToolDefinition]:
        return [
            self._definitions[name] for name in tool_names if name in self._definitions
        ]
