"""Tests for the HTTP streaming API adapter."""

import json
from collections.abc import Iterator

from fastapi.testclient import TestClient

from simple_agent_poc.adapters.http.api import create_app
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
from simple_agent_poc.adapters.tools.ask_user import (
    TOOL_DEFINITION as ASK_USER_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.ask_user import (
    execute as ask_user_execute,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import LLMResponse, LLMStreamChunk, Message

from tests.helpers import _questions_args


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


def build_registry_with_ask_user() -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "default-model",
                    "system_prompt": "System prompt",
                    "tools": ["ask_user"],
                },
            }
        }
    )


def build_tool_executor_with_ask_user() -> BuiltinToolRegistry:
    registry = BuiltinToolRegistry()
    registry.register(ASK_USER_TOOL_DEF, ask_user_execute)
    return registry


class TestStreamPauseContinueAPI:
    """Tests for SSE pause/continue via HTTP."""

    def test_chat_stream_pauses_on_ask_user(self) -> None:
        chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="Your name?"),
                    },
                },
            },
        ]
        session_store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()
        registry = build_registry_with_ask_user()
        llm_client = StreamingStubLLMClient(chunks=chunks)

        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: llm_client,
                session_store=session_store,
                agent_definitions=registry,
                tool_executor=tool_executor,
                is_api_context=True,
            )
        )
        client = TestClient(app)

        response = client.post("/api/chat/stream", json={"message": "Hello"})

        assert response.status_code == 200
        events = parse_sse_events(response.text)
        assert events[0]["event"] == "tool_call"
        assert events[1]["event"] == "paused"
        paused_data = json.loads(events[1]["data"])
        assert "session_id" in paused_data
        assert paused_data["questions"][0]["question"] == "Your name?"

    def test_chat_continue_resumes_session(self) -> None:
        first_chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="Your name?"),
                    },
                },
            },
        ]
        second_chunks: list[LLMStreamChunk] = [
            {"content_delta": "Nice to meet you, Alice!"},
        ]
        session_store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()
        registry = build_registry_with_ask_user()

        def make_use_case(chunks):
            return RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=chunks
                ),
                session_store=session_store,
                agent_definitions=registry,
                tool_executor=tool_executor,
                is_api_context=True,
            )

        app = create_app(use_case_factory=lambda: make_use_case(first_chunks))
        client = TestClient(app)

        stream_resp = client.post("/api/chat/stream", json={"message": "Hello"})
        stream_events = parse_sse_events(stream_resp.text)
        paused_data = json.loads(stream_events[1]["data"])
        session_id = paused_data["session_id"]

        app2 = create_app(use_case_factory=lambda: make_use_case(second_chunks))
        client2 = TestClient(app2)

        continue_resp = client2.post(
            "/api/chat/stream/continue",
            json={"session_id": session_id, "answer": "Alice"},
        )

        assert continue_resp.status_code == 200
        continue_events = parse_sse_events(continue_resp.text)
        assert continue_events[0]["event"] == "tool_result"
        assert continue_events[1]["event"] == "delta"
        assert continue_events[2]["event"] == "complete"
        assert continue_events[3]["event"] == "done"

    def test_chat_continue_pauses_on_next_unanswered_ask_user(self) -> None:
        first_chunks: list[LLMStreamChunk] = [
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 0,
                    "id": "call_001",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="First number?"),
                    },
                },
            },
            {
                "content_delta": None,
                "tool_call_delta": {
                    "index": 1,
                    "id": "call_002",
                    "type": "function",
                    "function": {
                        "name": "ask_user",
                        "arguments": _questions_args(question_text="Second number?"),
                    },
                },
            },
        ]
        session_store = InMemorySessionStore()
        tool_executor = build_tool_executor_with_ask_user()
        registry = build_registry_with_ask_user()

        def fail_if_llm_is_called(_agent_definition):
            raise AssertionError("LLM must not be called before all tool calls answer")

        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=first_chunks
                ),
                session_store=session_store,
                agent_definitions=registry,
                tool_executor=tool_executor,
                is_api_context=True,
            )
        )
        client = TestClient(app)

        stream_resp = client.post("/api/chat/stream", json={"message": "Add numbers"})
        stream_events = parse_sse_events(stream_resp.text)
        paused_data = json.loads(stream_events[2]["data"])

        app2 = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=fail_if_llm_is_called,
                session_store=session_store,
                agent_definitions=registry,
                tool_executor=tool_executor,
                is_api_context=True,
            )
        )
        client2 = TestClient(app2)

        continue_resp = client2.post(
            "/api/chat/stream/continue",
            json={"session_id": paused_data["session_id"], "answer": "1"},
        )

        assert continue_resp.status_code == 200
        continue_events = parse_sse_events(continue_resp.text)
        assert continue_events[0]["event"] == "tool_result"
        result_data = json.loads(continue_events[0]["data"])
        assert result_data["call_id"] == "call_001"
        assert continue_events[1]["event"] == "paused"
        next_paused_data = json.loads(continue_events[1]["data"])
        assert next_paused_data["call_id"] == "call_002"
        assert next_paused_data["questions"][0]["question"] == "Second number?"
        assert continue_events[2]["event"] == "done"

    def test_chat_continue_with_unknown_session_returns_error(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=[]
                ),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry_with_ask_user(),
                is_api_context=True,
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat/stream/continue",
            json={"session_id": "missing", "answer": "no"},
        )

        assert response.status_code == 200
        events = parse_sse_events(response.text)
        assert events[0]["event"] == "error"
        assert "not found" in json.loads(events[0]["data"])["detail"].lower()

    def test_chat_continue_with_non_paused_session_returns_error(self) -> None:
        session_store = InMemorySessionStore()
        from simple_agent_poc.core.session import ConversationSession

        session = ConversationSession.start(
            session_id="active",
            system_prompt="System prompt",
        )
        session.append_user_message("Hello")
        session.append_assistant_message("Hi")
        session_store.save(session)

        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=[]
                ),
                session_store=session_store,
                agent_definitions=build_registry_with_ask_user(),
                is_api_context=True,
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat/stream/continue",
            json={"session_id": "active", "answer": "no"},
        )

        assert response.status_code == 200
        events = parse_sse_events(response.text)
        assert events[0]["event"] == "error"
        assert "paused" in json.loads(events[0]["data"])["detail"].lower()

    def test_chat_continue_rejects_blank_answer(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StreamingStubLLMClient(
                    chunks=[]
                ),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry_with_ask_user(),
                is_api_context=True,
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat/stream/continue",
            json={"session_id": "abc", "answer": "   "},
        )

        assert response.status_code == 422
