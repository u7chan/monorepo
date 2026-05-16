"""Application ports."""

from collections.abc import Iterator
from typing import Protocol

from simple_agent_poc.core.agent_definition import AgentDefinition
from simple_agent_poc.core.session import ConversationSession
from simple_agent_poc.core.types import (
    LLMResponse,
    LLMStreamChunk,
    Message,
    ToolCall,
    ToolDefinition,
)


class ToolExecutor(Protocol):
    """Execute built-in tools by name."""

    def execute(self, tool_call: ToolCall, /) -> str:
        """Execute a tool call and return the result string."""

    def get_definitions(self, tool_names: list[str], /) -> list[ToolDefinition]:
        """Return tool definitions for the given tool names."""


class LLMClient(Protocol):
    """Interface for LLM clients."""

    def complete(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> LLMResponse:
        """Receive message history and return an LLM response."""

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]:
        """Receive message history and yield streaming chunks."""


class LLMClientFactory(Protocol):
    """Factory for agent-specific LLM clients."""

    def __call__(self, agent_definition: AgentDefinition, /) -> LLMClient:
        """Create an LLM client for the selected agent."""


class SessionStore(Protocol):
    """Persistence boundary for conversation sessions."""

    def get(self, session_id: str) -> ConversationSession | None:
        """Return a stored session if it exists."""

    def save(self, session: ConversationSession) -> None:
        """Persist the latest session state."""
