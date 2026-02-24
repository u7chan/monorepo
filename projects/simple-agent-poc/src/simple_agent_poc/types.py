"""Type definitions for the agent."""

from typing import Literal, TypedDict


class AgentError(Exception):
    """Base exception for agent errors."""

    def __init__(self, message: str, display_message: str | None = None) -> None:
        super().__init__(message)
        self.display_message = display_message or message


class AuthenticationError(AgentError):
    """Raised when API authentication fails."""

    pass


class RateLimitError(AgentError):
    """Raised when rate limit is exceeded."""

    pass


class LLMError(AgentError):
    """Raised for general LLM errors."""

    pass


class ValidationError(AgentError):
    """Raised when validation fails."""

    pass


type MessageRole = Literal["system", "user", "assistant"]


class Message(TypedDict):
    role: MessageRole
    content: str


class Usage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class LLMResponse(TypedDict):
    content: str
    usage: Usage
    model: str
    response_time: float
