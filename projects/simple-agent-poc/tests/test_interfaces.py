"""Tests for application ports."""

from typing import get_type_hints

from simple_agent_poc.application.ports import LLMClient, SessionStore
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import LLMResponse


class TestLLMClient:
    """Tests for the LLMClient protocol."""

    def test_protocol_has_complete_method(self) -> None:
        assert hasattr(LLMClient, "complete")

    def test_complete_signature(self) -> None:
        hints = get_type_hints(LLMClient.complete)

        assert hints.get("return") == LLMResponse

    def test_protocol_is_callable(self) -> None:
        assert hasattr(LLMClient, "__protocol_attrs__")


class TestSessionStore:
    """Tests for the SessionStore protocol."""

    def test_protocol_has_required_methods(self) -> None:
        assert hasattr(SessionStore, "get")
        assert hasattr(SessionStore, "save")

    def test_get_signature(self) -> None:
        hints = get_type_hints(SessionStore.get)

        assert hints.get("return") == ConversationSession | None
