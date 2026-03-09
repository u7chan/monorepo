"""Application ports."""

from typing import Protocol

from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import LLMResponse, Message


class LLMClient(Protocol):
    """Interface for LLM clients."""

    def complete(self, messages: list[Message]) -> LLMResponse:
        """Receive message history and return an LLM response."""


class SessionStore(Protocol):
    """Persistence boundary for conversation sessions."""

    def get(self, session_id: str) -> ConversationSession | None:
        """Return a stored session if it exists."""

    def save(self, session: ConversationSession) -> None:
        """Persist the latest session state."""
