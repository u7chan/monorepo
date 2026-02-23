"""Protocol interfaces."""

from typing import Protocol

from simple_agent_poc.types import LLMResponse, Message


class LLMClient(Protocol):
    """Interface for LLM clients"""

    def complete(self, messages: list[Message]) -> LLMResponse:
        """Receive message history and return LLM response"""
        ...
