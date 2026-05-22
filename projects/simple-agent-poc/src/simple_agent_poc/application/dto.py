"""Application DTOs."""

from dataclasses import dataclass

from simple_agent_poc.core.types import Usage


@dataclass(frozen=True, slots=True)
class RunAgentRequest:
    """Request DTO for reusable agent execution."""

    message: str
    session_id: str | None = None
    agent_id: str = "default"


@dataclass(frozen=True, slots=True)
class ContentDelta:
    """Partial text emitted during streaming."""

    delta: str


@dataclass(frozen=True, slots=True)
class StreamComplete:
    """Metadata emitted when a stream finishes successfully."""

    session_id: str
    usage: Usage | None
    model: str
    response_time: float


@dataclass(frozen=True, slots=True)
class ToolCallEvent:
    """Emitted when the agent initiates a tool call."""

    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True, slots=True)
class ToolResultEvent:
    """Emitted when a tool execution completes."""

    call_id: str
    name: str
    result: str


@dataclass(frozen=True, slots=True)
class ContinueRequest:
    """Request DTO for resuming a paused session."""

    session_id: str
    answers: dict[str, str]


@dataclass(frozen=True, slots=True)
class SessionPaused:
    """Pause notification emitted when ask_user is called in API mode."""

    session_id: str
    call_id: str
    questions: list[dict]
