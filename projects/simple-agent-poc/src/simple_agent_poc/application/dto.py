"""Application DTOs."""

from dataclasses import dataclass

from simple_agent_poc.core.types import LLMResponse, Usage


@dataclass(frozen=True, slots=True)
class RunAgentRequest:
    """Request DTO for reusable agent execution."""

    message: str
    session_id: str | None = None
    agent_id: str = "default"


@dataclass(frozen=True, slots=True)
class ToolCallRecord:
    """A single tool call and its result recorded during agent execution."""

    call_id: str
    name: str
    arguments: str
    result: str


@dataclass(frozen=True, slots=True)
class RunAgentResponse:
    """Response DTO for reusable agent execution."""

    message: str
    usage: Usage
    model: str
    response_time: float
    session_id: str
    tool_call_history: list[ToolCallRecord]

    @classmethod
    def from_llm_response(
        cls,
        response: LLMResponse,
        *,
        session_id: str,
        tool_call_history: list[ToolCallRecord] | None = None,
    ) -> "RunAgentResponse":
        """Build the application DTO from a raw LLM response."""
        return cls(
            message=response["content"],
            usage=response["usage"],
            model=response["model"],
            response_time=response["response_time"],
            session_id=session_id,
            tool_call_history=tool_call_history or [],
        )


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


@dataclass(frozen=True, slots=True)
class RunAgentPaused:
    """Pause result returned by sync execution when ask_user is called."""

    session_id: str
    call_id: str
    questions: list[dict]
    tool_call_history: list[ToolCallRecord]
