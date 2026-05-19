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


def _batch_questions_args() -> str:
    """Build a multi-question ask_user arguments JSON (text + choice mixed)."""
    return json.dumps(
        {
            "questions": [
                {
                    "question": "プロジェクト名は？",
                    "header": "Project",
                    "type": "text",
                    "placeholder": "例: my-app",
                },
                {
                    "question": "どのデータベースを使いますか？",
                    "header": "Database",
                    "type": "choice",
                    "options": [
                        {"label": "PostgreSQL", "description": "OSS RDBMS"},
                        {"label": "SQLite", "description": "Lightweight embedded DB"},
                    ],
                    "multiSelect": False,
                },
                {
                    "question": "どの言語を使いますか？",
                    "header": "Language",
                    "type": "choice",
                    "options": [
                        {"label": "TypeScript", "description": "Type-safe JS"},
                        {"label": "Python", "description": "General-purpose"},
                    ],
                    "multiSelect": False,
                },
            ]
        }
    )


def _over_limit_questions_args() -> str:
    """Build a questions JSON with 5 questions (over the max limit)."""
    return json.dumps(
        {
            "questions": [
                {"question": f"Question {i}", "type": "text"} for i in range(1, 6)
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
