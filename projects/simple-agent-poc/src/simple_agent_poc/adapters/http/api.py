"""HTTP API adapter."""

import json
from dataclasses import asdict
from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from starlette.responses import HTMLResponse, StreamingResponse

from simple_agent_poc.application.dto import (
    ContentDelta,
    ContinueRequest,
    RunAgentPaused,
    RunAgentRequest,
    RunAgentResponse,
    SessionPaused,
    StreamComplete,
    ToolCallEvent,
    ToolCallRecord,
    ToolResultEvent,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.types import (
    SessionNotFoundError,
    SessionNotPausedError,
    Usage,
    ValidationError,
)
from simple_agent_poc.adapters.http.test_page import TEST_PAGE_HTML
from simple_agent_poc.entrypoints.bootstrap import create_run_agent_use_case_factory


class ChatRequest(BaseModel):
    """HTTP request schema for chat execution."""

    model_config = ConfigDict(str_strip_whitespace=True)

    message: str
    session_id: str | None = None
    agent_id: str = "default"

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        """Reject blank messages after trimming whitespace."""
        if not value:
            raise ValueError("message must not be blank")
        return value

    @field_validator("agent_id")
    @classmethod
    def validate_agent_id(cls, value: str) -> str:
        """Reject blank agent ids after trimming whitespace."""
        if not value:
            raise ValueError("agent_id must not be blank")
        return value


class SyncChatResponse(BaseModel):
    """HTTP response schema for synchronous chat execution.

    Uses a ``status`` field to discriminate between completed and paused.
    """

    status: Literal["completed", "paused"]
    session_id: str
    tool_calls: list[ToolCallRecord] = []
    message: str = ""
    usage: Usage | None = None
    model: str = ""
    response_time: float = 0.0
    call_id: str = ""
    question: str = ""

    @classmethod
    def from_completed(cls, response: RunAgentResponse) -> "SyncChatResponse":
        """Build from a completed use case response."""
        return cls(
            status="completed",
            message=response.message,
            usage=response.usage,
            model=response.model,
            response_time=response.response_time,
            session_id=response.session_id,
            tool_calls=response.tool_call_history,
        )

    @classmethod
    def from_paused(cls, paused: RunAgentPaused) -> "SyncChatResponse":
        """Build from a paused use case response."""
        return cls(
            status="paused",
            session_id=paused.session_id,
            call_id=paused.call_id,
            question=paused.question,
            tool_calls=paused.tool_call_history,
        )


class ResumeRequest(BaseModel):
    """HTTP request schema for resuming a paused session."""

    model_config = ConfigDict(str_strip_whitespace=True)

    session_id: str
    answer: str

    @field_validator("session_id")
    @classmethod
    def validate_session_id(cls, value: str) -> str:
        """Reject blank session ids after trimming whitespace."""
        if not value:
            raise ValueError("session_id must not be blank")
        return value

    @field_validator("answer")
    @classmethod
    def validate_answer(cls, value: str) -> str:
        """Reject blank answers after trimming whitespace."""
        if not value:
            raise ValueError("answer must not be blank")
        return value


def resolve_session_id(
    *,
    header_session_id: str | None,
    body_session_id: str | None,
) -> str | None:
    """Resolve the effective session ID across supported HTTP transports."""
    if header_session_id is None:
        return body_session_id

    if body_session_id is None or body_session_id == header_session_id:
        return header_session_id

    raise HTTPException(
        status_code=400,
        detail=(
            "Conflicting session_id values were provided in the Session-Id header "
            "and request body."
        ),
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

    @app.post("/api/chat/sync", response_model=SyncChatResponse)
    def chat_sync(
        request: ChatRequest,
        run_agent: Annotated[RunAgentUseCase, Depends(get_run_agent_use_case)],
        *,
        session_id_header: Annotated[
            str | None,
            Header(alias="Session-Id"),
        ] = None,
    ) -> SyncChatResponse:
        try:
            result = run_agent.execute(
                RunAgentRequest(
                    message=request.message,
                    session_id=resolve_session_id(
                        header_session_id=session_id_header,
                        body_session_id=request.session_id,
                    ),
                    agent_id=request.agent_id,
                )
            )
        except SessionNotFoundError as error:
            raise HTTPException(
                status_code=404, detail=error.display_message
            ) from error
        except ValidationError as error:
            raise HTTPException(
                status_code=400, detail=error.display_message
            ) from error

        if isinstance(result, RunAgentPaused):
            return SyncChatResponse.from_paused(result)
        return SyncChatResponse.from_completed(result)

    @app.post("/api/chat/sync/continue", response_model=SyncChatResponse)
    def chat_sync_continue(
        request: ResumeRequest,
        run_agent: Annotated[RunAgentUseCase, Depends(get_run_agent_use_case)],
    ) -> SyncChatResponse:
        try:
            result = run_agent.continue_sync(
                ContinueRequest(
                    session_id=request.session_id,
                    answer=request.answer,
                )
            )
        except SessionNotFoundError as error:
            raise HTTPException(
                status_code=404, detail=error.display_message
            ) from error
        except SessionNotPausedError as error:
            raise HTTPException(
                status_code=400, detail=error.display_message
            ) from error
        except ValidationError as error:
            raise HTTPException(
                status_code=400, detail=error.display_message
            ) from error

        if isinstance(result, RunAgentPaused):
            return SyncChatResponse.from_paused(result)
        return SyncChatResponse.from_completed(result)

    @app.post("/api/chat/stream")
    def chat_stream(
        request: ChatRequest,
        run_agent: Annotated[RunAgentUseCase, Depends(get_run_agent_use_case)],
        *,
        session_id_header: Annotated[
            str | None,
            Header(alias="Session-Id"),
        ] = None,
    ):
        session_id = resolve_session_id(
            header_session_id=session_id_header,
            body_session_id=request.session_id,
        )

        def event_stream():
            try:
                for event in run_agent.execute_stream(
                    RunAgentRequest(
                        message=request.message,
                        session_id=session_id,
                        agent_id=request.agent_id,
                    )
                ):
                    if isinstance(event, ContentDelta):
                        yield f"event: delta\ndata: {json.dumps({'content': event.delta}, ensure_ascii=False)}\n\n"
                    elif isinstance(event, ToolCallEvent):
                        yield f"event: tool_call\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                    elif isinstance(event, ToolResultEvent):
                        yield f"event: tool_result\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                    elif isinstance(event, SessionPaused):
                        yield f"event: paused\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                        yield "event: done\ndata: {}\n\n"
                        return
                    elif isinstance(event, StreamComplete):
                        yield f"event: complete\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                yield "event: done\ndata: {}\n\n"
            except SessionNotFoundError as error:
                yield f"event: error\ndata: {json.dumps({'detail': error.display_message}, ensure_ascii=False)}\n\n"
            except ValidationError as error:
                yield f"event: error\ndata: {json.dumps({'detail': error.display_message}, ensure_ascii=False)}\n\n"
            except Exception as error:
                yield f"event: error\ndata: {json.dumps({'detail': str(error)}, ensure_ascii=False)}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    @app.post("/api/chat/stream/continue")
    def chat_stream_continue(
        request: ResumeRequest,
        run_agent: Annotated[RunAgentUseCase, Depends(get_run_agent_use_case)],
    ):
        def event_stream():
            try:
                for event in run_agent.continue_stream(
                    ContinueRequest(
                        session_id=request.session_id,
                        answer=request.answer,
                    )
                ):
                    if isinstance(event, ContentDelta):
                        yield f"event: delta\ndata: {json.dumps({'content': event.delta}, ensure_ascii=False)}\n\n"
                    elif isinstance(event, ToolCallEvent):
                        yield f"event: tool_call\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                    elif isinstance(event, ToolResultEvent):
                        yield f"event: tool_result\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                    elif isinstance(event, SessionPaused):
                        yield f"event: paused\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                        yield "event: done\ndata: {}\n\n"
                        return
                    elif isinstance(event, StreamComplete):
                        yield f"event: complete\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
                yield "event: done\ndata: {}\n\n"
            except SessionNotFoundError as error:
                yield f"event: error\ndata: {json.dumps({'detail': error.display_message}, ensure_ascii=False)}\n\n"
            except SessionNotPausedError as error:
                yield f"event: error\ndata: {json.dumps({'detail': error.display_message}, ensure_ascii=False)}\n\n"
            except ValidationError as error:
                yield f"event: error\ndata: {json.dumps({'detail': error.display_message}, ensure_ascii=False)}\n\n"
            except Exception as error:
                yield f"event: error\ndata: {json.dumps({'detail': str(error)}, ensure_ascii=False)}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    @app.get("/", response_class=HTMLResponse)
    def test_page() -> HTMLResponse:
        return HTMLResponse(TEST_PAGE_HTML)

    return app
