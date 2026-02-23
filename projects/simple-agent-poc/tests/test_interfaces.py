"""Tests for interfaces module."""

from typing import get_type_hints

from simple_agent_poc.interfaces import LLMClient
from simple_agent_poc.types import LLMResponse, Message


class TestLLMClient:
    """Tests for LLMClient protocol."""

    def test_protocol_has_complete_method(self) -> None:
        """Test that LLMClient protocol has complete method."""
        assert hasattr(LLMClient, "complete")

    def test_complete_signature(self) -> None:
        """Test complete method signature."""
        hints = get_type_hints(LLMClient.complete)

        # Check return type
        assert hints.get("return") == LLMResponse

    def test_protocol_is_callable(self) -> None:
        """Test that LLMClient is a proper Protocol."""
        # Protocol should not be instantiable
        assert hasattr(LLMClient, "__protocol_attrs__")
