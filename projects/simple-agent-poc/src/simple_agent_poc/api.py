"""HTTP API adapter."""

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, FastAPI
from pydantic import BaseModel, ConfigDict, field_validator

from simple_agent_poc.application import (
    RunAgentRequest,
    RunAgentResponse,
    RunAgentUseCase,
)
from simple_agent_poc.bootstrap import create_run_agent_use_case
from simple_agent_poc.types import Usage


class ChatRequest(BaseModel):
    """HTTP request schema for chat execution."""

    model_config = ConfigDict(str_strip_whitespace=True)

    message: str

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        """Reject blank messages after trimming whitespace."""
        if not value:
            raise ValueError("message must not be blank")
        return value


class ChatResponse(BaseModel):
    """HTTP response schema for chat execution."""

    message: str
    usage: Usage
    model: str
    response_time: float

    @classmethod
    def from_use_case_response(cls, response: RunAgentResponse) -> "ChatResponse":
        """Build the HTTP response payload from the application DTO."""
        return cls(
            message=response.message,
            usage=response.usage,
            model=response.model,
            response_time=response.response_time,
        )


def create_app(
    *,
    use_case_factory: Callable[[], RunAgentUseCase] = create_run_agent_use_case,
) -> FastAPI:
    """Create the FastAPI application."""
    app = FastAPI(title="simple-agent-poc")

    def get_run_agent_use_case() -> RunAgentUseCase:
        return use_case_factory()

    @app.post("/api/chat", response_model=ChatResponse)
    def chat(
        request: ChatRequest,
        run_agent: Annotated[RunAgentUseCase, Depends(get_run_agent_use_case)],
    ) -> ChatResponse:
        response = run_agent.execute(RunAgentRequest(message=request.message))
        return ChatResponse.from_use_case_response(response)

    return app
