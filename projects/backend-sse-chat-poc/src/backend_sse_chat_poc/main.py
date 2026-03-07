from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from uuid import uuid4

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator

from backend_sse_chat_poc.llm import ChatStreamer, build_default_streamer
from backend_sse_chat_poc.service import ChatService
from backend_sse_chat_poc.store import InMemoryConversationStore

BASE_DIR = Path(__file__).resolve().parents[2]
TEMPLATES = Jinja2Templates(directory=str(BASE_DIR / "templates"))


class CreateMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            msg = "content must not be blank"
            raise ValueError(msg)
        return trimmed


class CreateMessageResponse(BaseModel):
    conversation_id: str
    user_message: dict[str, object]
    assistant_message: dict[str, object]
    generation: dict[str, object]


class ConversationStateResponse(BaseModel):
    conversation_id: str
    messages: list[dict[str, object]]
    generations: list[dict[str, object]]
    last_event_id: int


async def get_chat_service(request: Request) -> ChatService:
    service = getattr(request.app.state, "chat_service", None)
    if service is None:
        raise HTTPException(status_code=500, detail="chat service is not initialized")
    return service


ServiceDep = Annotated[ChatService, Depends(get_chat_service)]


def create_app(*, streamer: ChatStreamer | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.chat_service = ChatService(
            store=InMemoryConversationStore(),
            streamer=streamer or build_default_streamer(),
        )
        yield
        await app.state.chat_service.shutdown()

    app = FastAPI(title="Backend SSE Chat PoC", lifespan=lifespan)

    @app.get("/")
    async def root() -> RedirectResponse:
        return RedirectResponse(url=f"/conversations/{uuid4().hex}", status_code=307)

    @app.get("/conversations/{conversation_id}", response_class=HTMLResponse)
    async def conversation_page(
        request: Request,
        conversation_id: str,
        chat_service: ServiceDep,
    ) -> HTMLResponse:
        await chat_service.ensure_conversation(conversation_id)
        return TEMPLATES.TemplateResponse(
            request=request,
            name="chat.html",
            context={
                "conversation_id": conversation_id,
            },
        )

    @app.post(
        "/conversations/{conversation_id}/messages",
        response_model=CreateMessageResponse,
        status_code=202,
    )
    async def create_message(
        conversation_id: str,
        payload: CreateMessageRequest,
        chat_service: ServiceDep,
    ) -> CreateMessageResponse:
        result = await chat_service.create_message(conversation_id, payload.content)
        return CreateMessageResponse.model_validate(result)

    @app.get(
        "/conversations/{conversation_id}/state",
        response_model=ConversationStateResponse,
    )
    async def get_state(
        conversation_id: str, chat_service: ServiceDep
    ) -> ConversationStateResponse:
        state = await chat_service.get_state(conversation_id)
        return ConversationStateResponse.model_validate(state)

    @app.get("/conversations/{conversation_id}/events")
    async def get_events(
        request: Request,
        conversation_id: str,
        chat_service: ServiceDep,
        after: Annotated[int | None, Query(ge=0)] = None,
    ) -> StreamingResponse:
        header_after = request.headers.get("last-event-id")
        if header_after is not None:
            try:
                after_event_id = int(header_after)
            except ValueError:
                after_event_id = 0
        else:
            after_event_id = after or 0

        return StreamingResponse(
            chat_service.stream_events(
                conversation_id=conversation_id,
                request=request,
                after_event_id=after_event_id,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return app


app = create_app()


def main() -> None:
    uvicorn.run("backend_sse_chat_poc.main:app", host="0.0.0.0", port=8000, reload=True)
