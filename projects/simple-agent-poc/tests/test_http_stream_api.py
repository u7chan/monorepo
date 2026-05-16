"""Tests for the HTTP streaming API adapter."""

import json
from collections.abc import Iterator

from fastapi.testclient import TestClient

from simple_agent_poc.adapters.http.api import create_app
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import LLMResponse, LLMStreamChunk, Message


class StreamingStubLLMClient:
    """Stub LLM client for streaming HTTP tests."""

    def __init__(self, chunks: list[LLMStreamChunk]) -> None:
        self.chunks = chunks

    def complete(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> LLMResponse:
        raise NotImplementedError

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> Iterator[LLMStreamChunk]:
        yield from self.chunks


def build_registry() -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "default-model",
                    "system_prompt": "System prompt",
                },
            }
        }
    )


def parse_sse_events(data: str) -> list[dict[str, str]]:
    """Parse SSE response text into a list of event dicts."""
    events: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in data.splitlines():
        if not line:
            if current:
                events.append(current)
                current = {}
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            current[key.strip()] = value.strip()
    if current:
        events.append(current)
    return events


class TestStreamAPI:
    """Tests for the streaming HTTP endpoint."""

    def test_chat_stream_returns_sse_events(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {"content_delta": "Hello"},
            {"content_delta": " world"},
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: llm_client,
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post("/api/chat/stream", json={"message": "Hello"})

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = parse_sse_events(response.text)
        assert events == [
            {"event": "delta", "data": '{"content": "Hello"}'},
            {"event": "delta", "data": '{"content": " world"}'},
            {"event": "complete", "data": events[2]["data"]},
            {"event": "done", "data": "{}"},
        ]
        complete_data = json.loads(events[2]["data"])
        assert complete_data["model"] == "default-model"
        assert "session_id" in complete_data
        assert "usage" in complete_data
        assert "response_time" in complete_data

    def test_chat_stream_error_for_blank_message(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=[]
                ),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post("/api/chat/stream", json={"message": "   "})

        assert response.status_code == 422

    def test_chat_stream_error_for_unknown_agent(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=[]
                ),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat/stream",
            json={"message": "Hello", "agent_id": "missing"},
        )

        assert response.status_code == 200
        events = parse_sse_events(response.text)
        assert events[0]["event"] == "error"

    def test_chat_stream_returns_streaming_response(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {"content_delta": "Streaming reply"},
        ]
        llm_client = StreamingStubLLMClient(chunks=chunks)
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: llm_client,
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post("/api/chat/stream", json={"message": "Hello"})

        assert response.status_code == 200
        events = parse_sse_events(response.text)
        assert any(e["event"] == "delta" for e in events)
        assert any(e["event"] == "complete" for e in events)
        assert any(e["event"] == "done" for e in events)
