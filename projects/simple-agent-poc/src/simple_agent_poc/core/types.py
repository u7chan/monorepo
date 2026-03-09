"""Shared core types and domain errors."""

from typing import Literal, TypedDict


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


MessageRole = Literal["system", "user", "assistant"]


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
