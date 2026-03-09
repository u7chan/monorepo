"""Application DTOs."""

from dataclasses import dataclass

from simple_agent_poc.core.types import LLMResponse, Usage


@dataclass(frozen=True, slots=True)
class RunAgentRequest:
    """Request DTO for reusable agent execution."""

    message: str
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class RunAgentResponse:
    """Response DTO for reusable agent execution."""

    message: str
    usage: Usage
    model: str
    response_time: float
    session_id: str

    @classmethod
    def from_llm_response(
        cls,
        response: LLMResponse,
        *,
        session_id: str,
    ) -> "RunAgentResponse":
        """Build the application DTO from a raw LLM response."""
        return cls(
            message=response["content"],
            usage=response["usage"],
            model=response["model"],
            response_time=response["response_time"],
            session_id=session_id,
        )
