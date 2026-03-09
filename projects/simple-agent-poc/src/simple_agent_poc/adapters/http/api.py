"""HTTP API adapter."""

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator

from simple_agent_poc.application.dto import RunAgentRequest, RunAgentResponse
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.types import SessionNotFoundError, Usage
from simple_agent_poc.entrypoints.bootstrap import create_run_agent_use_case_factory


class ChatRequest(BaseModel):
    """HTTP request schema for chat execution."""

    model_config = ConfigDict(str_strip_whitespace=True)

    message: str
    session_id: str | None = None

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
    session_id: str

    @classmethod
    def from_use_case_response(cls, response: RunAgentResponse) -> "ChatResponse":
        """Build the HTTP response payload from the application DTO."""
        return cls(
            message=response.message,
            usage=response.usage,
            model=response.model,
            response_time=response.response_time,
            session_id=response.session_id,
        )


def create_app(
    *,
    use_case_factory: Callable[[], RunAgentUseCase] | None = None,
) -> FastAPI:
    """Create the FastAPI application."""
    app = FastAPI(title="simple-agent-poc")
    factory = use_case_factory or create_run_agent_use_case_factory()

    def get_run_agent_use_case() -> RunAgentUseCase:
        return factory()

    @app.post("/api/chat", response_model=ChatResponse)
    def chat(
        request: ChatRequest,
        run_agent: Annotated[RunAgentUseCase, Depends(get_run_agent_use_case)],
    ) -> ChatResponse:
        try:
            response = run_agent.execute(
                RunAgentRequest(
                    message=request.message,
                    session_id=request.session_id,
                )
            )
        except SessionNotFoundError as error:
            raise HTTPException(
                status_code=404, detail=error.display_message
            ) from error

        return ChatResponse.from_use_case_response(response)

    return app
