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
            "追加情報が必要な場合にのみ使い、必要な質問をまとめて1回で送信してください（最大4問まで）。"
            "1度の呼び出しで必要な情報を全て聞き、ユーザーから十分な回答を得たら、"
            "このツールを再度呼び出さずに最終回答を生成してください。"
            "同じ内容を別の言い方で繰り返し質問しないでください。"
            "type: choice の場合、選択肢は入力補助のためであり、"
            "ユーザーが選択肢にない自由な回答をしてもそのまま受け入れ、"
            "再度このツールで確認しないでください。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "質問のリスト（1〜4個まとめて送信してください）",
                    "minItems": 1,
                    "maxItems": 4,
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
                                "enum": ["text", "choice"],
                                "description": "質問の種類",
                            },
                            "placeholder": {
                                "type": "string",
                                "description": "入力欄のプレースホルダー",
                            },
                            "options": {
                                "type": "array",
                                "description": "選択肢のリスト（type=choice の場合）",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "description": "選択肢のラベル",
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "選択肢の説明",
                                        },
                                    },
                                    "required": ["label"],
                                },
                            },
                            "multiSelect": {
                                "type": "boolean",
                                "description": "複数選択を許可するか（type=choice の場合）",
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
                    f"質問「{question_text}」には自動で回答できません。"
                    "ユーザーからの入力が必要です。"
                ),
            },
        },
        ensure_ascii=False,
    )
