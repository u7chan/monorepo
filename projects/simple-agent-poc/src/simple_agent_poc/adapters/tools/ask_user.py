"""ask_user — prompts the user for input during conversation."""

import json
from typing import Any

from simple_agent_poc.core.types import ToolDefinition

TOOL_DEFINITION: ToolDefinition = {
    "type": "function",
    "function": {
        "name": "ask_user",
        "description": "ユーザーに対して質問を行い、回答を取得します。",
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "ユーザーに尋ねる質問内容",
                },
            },
            "required": ["question"],
        },
    },
}


def execute(arguments: dict[str, Any]) -> str:
    return json.dumps({"answer": ""}, ensure_ascii=False)
