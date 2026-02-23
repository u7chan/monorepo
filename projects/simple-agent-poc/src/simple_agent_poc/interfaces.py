from typing import Protocol

from simple_agent_poc.types import Message


class LLMClient(Protocol):
    """Interface for LLM clients"""

    def complete(self, messages: list[Message]) -> str:
        """Receive message history and return LLM response"""
        ...
