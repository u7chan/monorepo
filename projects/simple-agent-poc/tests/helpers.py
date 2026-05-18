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


def _choice_questions_args(
    *,
    question_text: str = "Which database?",
    header: str = "Database",
    multi_select: bool = False,
) -> str:
    return json.dumps(
        {
            "questions": [
                {
                    "question": question_text,
                    "header": header,
                    "type": "choice",
                    "options": [
                        {"label": "PostgreSQL", "description": "OSS RDBMS"},
                        {"label": "SQLite", "description": "Lightweight embedded DB"},
                    ],
                    "multiSelect": multi_select,
                }
            ]
        }
    )
