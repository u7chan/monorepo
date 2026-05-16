"""concat — joins two strings and returns the result."""

import json
from typing import Any

from simple_agent_poc.core.types import ToolDefinition

TOOL_DEFINITION: ToolDefinition = {
    "type": "function",
    "function": {
        "name": "concat",
        "description": "2つの文字列を結合して返します。",
        "parameters": {
            "type": "object",
            "properties": {
                "a": {
                    "type": "string",
                    "description": "1つ目の文字列",
                },
                "b": {
                    "type": "string",
                    "description": "2つ目の文字列",
                },
            },
            "required": ["a", "b"],
        },
    },
}


def execute(arguments: dict[str, Any]) -> str:
    a = arguments.get("a", "")
    b = arguments.get("b", "")
    return json.dumps(
        {"result": str(a) + str(b)},
        ensure_ascii=False,
    )
