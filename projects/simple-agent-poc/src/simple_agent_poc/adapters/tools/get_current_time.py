"""get_current_time — returns current UTC datetime in ISO 8601."""

import json
from datetime import datetime, timezone
from typing import Any

from simple_agent_poc.core.types import ToolDefinition

TOOL_DEFINITION: ToolDefinition = {
    "type": "function",
    "function": {
        "name": "get_current_time",
        "description": "現在の日時をUTCのISO 8601形式で返します。",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
}


def execute(arguments: dict[str, Any]) -> str:
    return json.dumps(
        {"datetime": datetime.now(timezone.utc).isoformat()},
        ensure_ascii=False,
    )
