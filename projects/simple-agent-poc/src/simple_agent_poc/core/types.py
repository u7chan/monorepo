"""Shared core types and domain errors."""

from typing import Literal, NotRequired, TypedDict


class AgentError(Exception):
    """Base exception for agent errors."""

    def __init__(self, message: str, display_message: str | None = None) -> None:
        super().__init__(message)
        self.display_message = display_message or message


class AuthenticationError(AgentError):
    """Raised when API authentication fails."""


class RateLimitError(AgentError):
    """Raised when rate limit is exceeded."""


class LLMError(AgentError):
    """Raised for general LLM errors."""


class ValidationError(AgentError):
    """Raised when validation fails."""


class SessionNotFoundError(AgentError):
    """Raised when a requested session does not exist."""


class SessionNotPausedError(AgentError):
    """Raised when continue is requested on a session that is not paused."""


MessageRole = Literal["system", "user", "assistant", "tool"]


class ToolCallFunction(TypedDict):
    name: str
    arguments: str


class ToolCall(TypedDict):
    id: str
    type: Literal["function"]
    function: ToolCallFunction


class Message(TypedDict):
    role: MessageRole
    content: str
    tool_calls: NotRequired[list[ToolCall]]
    tool_call_id: NotRequired[str]


class Usage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ToolFunctionDef(TypedDict):
    name: str
    description: str
    parameters: dict


class ToolDefinition(TypedDict):
    type: Literal["function"]
    function: ToolFunctionDef


class ToolCallFunctionDelta(TypedDict):
    name: str | None
    arguments: str | None


class ToolCallDelta(TypedDict):
    index: int
    id: str | None
    type: Literal["function"]
    function: ToolCallFunctionDelta


class LLMStreamChunk(TypedDict):
    content_delta: str | None
    tool_call_delta: NotRequired[ToolCallDelta]
    usage: NotRequired[Usage]
