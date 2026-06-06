from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
import json
from typing import Any


def utc_now() -> datetime:
    return datetime.now(UTC)


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class MessageStatus(StrEnum):
    QUEUED = "queued"
    STREAMING = "streaming"
    COMPLETED = "completed"
    FAILED = "failed"


class GenerationStatus(StrEnum):
    QUEUED = "queued"
    STREAMING = "streaming"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(slots=True)
class Message:
    id: str
    conversation_id: str
    role: MessageRole
    content: str
    status: MessageStatus
    version: int = 1
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)

    def touch(self) -> None:
        self.updated_at = utc_now()
        self.version += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "role": self.role.value,
            "content": self.content,
            "status": self.status.value,
            "version": self.version,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


@dataclass(slots=True)
class Generation:
    id: str
    conversation_id: str
    assistant_message_id: str
    status: GenerationStatus
    error: str | None = None
    sequence: int = 0
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)

    def touch(self) -> None:
        self.updated_at = utc_now()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "assistant_message_id": self.assistant_message_id,
            "status": self.status.value,
            "error": self.error,
            "sequence": self.sequence,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


@dataclass(slots=True)
class Conversation:
    id: str
    message_ids: list[str] = field(default_factory=list)
    generation_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ConversationEvent:
    event_id: int
    name: str
    data: dict[str, Any]

    def encode(self) -> str:
        payload = json.dumps(self.data, ensure_ascii=False)
        return f"id: {self.event_id}\nevent: {self.name}\ndata: {payload}\n\n"


@dataclass(slots=True)
class TurnDraft:
    conversation_id: str
    user_message: Message
    assistant_message: Message
    generation: Generation
