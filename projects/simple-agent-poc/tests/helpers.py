"""Shared test helpers for simple-agent-poc tests."""

import json


def _questions_args(
    *, question_text: str = "What is your name?", header: str = "Name"
) -> str:
    return json.dumps(
        {
            "questions": [
                {
                    "question": question_text,
                    "header": header,
                    "type": "text",
                }
            ]
        }
    )
