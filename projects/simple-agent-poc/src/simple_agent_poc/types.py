"""Type definitions for the agent."""

from typing import Literal, TypedDict

type MessageRole = Literal["user", "assistant"]


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
