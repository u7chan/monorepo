"""ask_user — prompts the user for input during conversation."""

import json
from typing import Any

from simple_agent_poc.core.types import ToolDefinition

TOOL_DEFINITION: ToolDefinition = {
    "type": "function",
    "function": {
        "name": "ask_user",
        "description": (
            "ユーザーに質問し、テキスト入力で回答を得ます。"
            "追加情報が必要な場合に使います。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "質問のリスト",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "ユーザーに表示する質問文",
                            },
                            "header": {
                                "type": "string",
                                "description": "質問の短いラベル（最大16文字）",
                            },
                            "type": {
                                "type": "string",
                                "enum": ["text"],
                                "description": "質問の種類",
                            },
                            "placeholder": {
                                "type": "string",
                                "description": "入力欄のプレースホルダー",
                            },
                        },
                        "required": ["question", "type"],
                    },
                },
            },
            "required": ["questions"],
        },
    },
}


def execute(arguments: dict[str, Any]) -> str:
    questions = arguments.get("questions", [])
    if not questions:
        return json.dumps(
            {"answers": {}},
            ensure_ascii=False,
        )
    q = questions[0]
    question_text = q.get("question", "")
    return json.dumps(
        {
            "answers": {
                question_text: (
                    "このツールは API ストリーミングモードでのみ利用可能です。"
                    f"質問「{question_text}」には回答できませんでした。"
                ),
            },
        },
        ensure_ascii=False,
    )
