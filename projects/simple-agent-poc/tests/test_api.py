"""Tests for the HTTP API adapter."""

from collections.abc import Iterator

from fastapi.testclient import TestClient

from simple_agent_poc.adapters.http.api import create_app
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import LLMResponse, LLMStreamChunk, Message


class StubLLMClient:
    """Deterministic LLM stub for HTTP adapter tests."""

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[list[Message]] = []

    def complete(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> LLMResponse:
        self.calls.append(list(messages))
        return {
            "content": self.reply,
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "stub-model",
            "response_time": 0.1,
        }

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> Iterator[LLMStreamChunk]:
        raise NotImplementedError


def unused_use_case_factory() -> RunAgentUseCase:
    """Build a minimal use case for requests that should fail validation first."""
    return RunAgentUseCase(
        llm_client_factory=lambda _agent_definition: StubLLMClient(reply="unused"),
        session_store=InMemorySessionStore(),
        agent_definitions=build_registry(),
    )


def build_registry() -> AgentDefinitionRegistry:
    return AgentDefinitionRegistry.from_mapping(
        {
            "agents": {
                "default": {
                    "model": "default-model",
                    "system_prompt": "System prompt",
                },
                "researcher": {
                    "model": "research-model",
                    "system_prompt": "Research prompt",
                },
            }
        }
    )


class TestAPI:
    """Tests for the FastAPI adapter."""

    def test_chat_returns_use_case_response_with_session_id(self) -> None:
        llm_client = StubLLMClient(reply="Hello, user!")
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: llm_client,
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post("/api/chat", json={"message": "Hello"})

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Hello, user!"
        assert data["model"] == "stub-model"
        assert data["session_id"]

    def test_chat_rejects_missing_message(self) -> None:
        app = create_app(use_case_factory=unused_use_case_factory)
        client = TestClient(app)

        response = client.post("/api/chat", json={})

        assert response.status_code == 422

    def test_chat_rejects_blank_message(self) -> None:
        app = create_app(use_case_factory=unused_use_case_factory)
        client = TestClient(app)

        response = client.post("/api/chat", json={"message": "   "})

        assert response.status_code == 422

    def test_chat_reuses_session_across_new_use_case_instances(self) -> None:
        store = InMemorySessionStore()
        first_llm = StubLLMClient(reply="First")
        second_llm = StubLLMClient(reply="Second")
        llm_clients = iter([first_llm, second_llm])

        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: next(llm_clients),
                session_store=store,
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        first_response = client.post("/api/chat", json={"message": "Hello"})
        session_id = first_response.json()["session_id"]
        second_response = client.post(
            "/api/chat",
            headers={"Session-Id": session_id},
            json={"message": "Again"},
        )

        assert first_response.status_code == 200
        assert second_response.status_code == 200
        assert second_response.json()["message"] == "Second"
        assert second_llm.calls[0] == [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "First"},
            {"role": "user", "content": "Again"},
        ]

    def test_chat_accepts_body_session_id_for_compatibility(self) -> None:
        store = InMemorySessionStore()
        first_llm = StubLLMClient(reply="First")
        second_llm = StubLLMClient(reply="Second")
        llm_clients = iter([first_llm, second_llm])

        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: next(llm_clients),
                session_store=store,
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        first_response = client.post("/api/chat", json={"message": "Hello"})
        session_id = first_response.json()["session_id"]
        second_response = client.post(
            "/api/chat",
            json={"message": "Again", "session_id": session_id},
        )

        assert first_response.status_code == 200
        assert second_response.status_code == 200
        assert second_response.json()["message"] == "Second"

    def test_chat_returns_404_for_unknown_session_header(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StubLLMClient(
                    reply="unused"
                ),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat",
            headers={"Session-Id": "missing-session"},
            json={"message": "Hello"},
        )

        assert response.status_code == 404
        assert response.json() == {"detail": "Session not found."}

    def test_chat_returns_400_for_conflicting_session_transports(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StubLLMClient(
                    reply="unused"
                ),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat",
            headers={"Session-Id": "header-session"},
            json={"message": "Hello", "session_id": "body-session"},
        )

        assert response.status_code == 400
        assert response.json() == {
            "detail": (
                "Conflicting session_id values were provided in the "
                "Session-Id header and request body."
            )
        }

    def test_chat_uses_body_agent_id(self) -> None:
        llm_client = StubLLMClient(reply="Research reply")
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: llm_client,
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response = client.post(
            "/api/chat",
            json={"message": "Hello", "agent_id": "researcher"},
        )

        assert response.status_code == 200
        assert llm_client.calls[0] == [
            {"role": "system", "content": "Research prompt"},
            {"role": "user", "content": "Hello"},
        ]

    def test_chat_returns_400_for_unknown_agent_id(self) -> None:
        app = create_app(use_case_factory=unused_use_case_factory)
        client = TestClient(app)

        response = client.post(
            "/api/chat",
            json={"message": "Hello", "agent_id": "missing"},
        )

        assert response.status_code == 400
        assert response.json() == {"detail": "Unknown agent_id: missing"}

    def test_chat_returns_400_when_agent_changes_for_session(self) -> None:
        store = InMemorySessionStore()
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StubLLMClient(
                    reply="Reply"
                ),
                session_store=store,
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        first_response = client.post("/api/chat", json={"message": "Hello"})
        session_id = first_response.json()["session_id"]
        second_response = client.post(
            "/api/chat",
            headers={"Session-Id": session_id},
            json={"message": "Again", "agent_id": "researcher"},
        )

        assert second_response.status_code == 400
        assert second_response.json() == {
            "detail": "agent_id cannot be changed for an existing session"
        }


class TestSSEEvents:
    """Tests for SSE event format for tool_call and tool_result."""

    def test_sse_format_tool_call(self) -> None:
        import json
        from dataclasses import asdict

        from simple_agent_poc.application.dto import ToolCallEvent

        event = ToolCallEvent(
            call_id="call_001",
            name="concat",
            arguments='{"a":"hello","b":"world"}',
        )
        sse_line = f"event: tool_call\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
        assert "event: tool_call" in sse_line
        assert "call_001" in sse_line
        assert "concat" in sse_line

    def test_sse_format_tool_result(self) -> None:
        import json
        from dataclasses import asdict

        from simple_agent_poc.application.dto import ToolResultEvent

        event = ToolResultEvent(
            call_id="call_001",
            name="concat",
            result='{"result":"helloworld"}',
        )
        sse_line = f"event: tool_result\ndata: {json.dumps(asdict(event), ensure_ascii=False)}\n\n"
        assert "event: tool_result" in sse_line
        assert "call_001" in sse_line
        assert "helloworld" in sse_line
