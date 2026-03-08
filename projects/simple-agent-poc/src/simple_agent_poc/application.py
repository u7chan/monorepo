"""Application use cases and DTOs."""

from dataclasses import dataclass

from simple_agent_poc.agent import Agent
from simple_agent_poc.types import LLMResponse, Usage


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
    session_id: str | None = None

    @classmethod
    def from_llm_response(
        cls,
        response: LLMResponse,
        *,
        session_id: str | None = None,
    ) -> "RunAgentResponse":
        """Build the application DTO from a raw LLM response."""
        return cls(
            message=response["content"],
            usage=response["usage"],
            model=response["model"],
            response_time=response["response_time"],
            session_id=session_id,
        )


class RunAgentUseCase:
    """Reusable execution path for agent interactions."""

    def __init__(self, agent: Agent) -> None:
        self._agent = agent

    def execute(self, request: RunAgentRequest) -> RunAgentResponse:
        """Run the agent for a single user message."""
        response = self._agent.process_user_input(request.message)
        return RunAgentResponse.from_llm_response(
            response,
            session_id=request.session_id,
        )
