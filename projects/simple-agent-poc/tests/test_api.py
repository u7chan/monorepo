"""Tests for the HTTP API adapter."""

from fastapi.testclient import TestClient

from simple_agent_poc.adapters.http.api import create_app
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.ports import LLMClient
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.types import LLMResponse, Message


class StubLLMClient(LLMClient):
    """Deterministic LLM stub for HTTP adapter tests."""

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[list[Message]] = []

    def complete(self, messages: list[Message]) -> LLMResponse:
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


class TestAPI:
    """Tests for the FastAPI adapter."""

    def test_chat_returns_use_case_response_with_session_id(self) -> None:
        llm_client = StubLLMClient(reply="Hello, user!")
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client=llm_client,
                session_store=InMemorySessionStore(),
                system_prompt="System prompt",
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
        app = create_app(use_case_factory=lambda: None)
        client = TestClient(app)

        response = client.post("/api/chat", json={})

        assert response.status_code == 422

    def test_chat_rejects_blank_message(self) -> None:
        app = create_app(use_case_factory=lambda: None)
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
                llm_client=next(llm_clients),
                session_store=store,
                system_prompt="System prompt",
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
                llm_client=next(llm_clients),
                session_store=store,
                system_prompt="System prompt",
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
                llm_client=StubLLMClient(reply="unused"),
                session_store=InMemorySessionStore(),
                system_prompt="System prompt",
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
                llm_client=StubLLMClient(reply="unused"),
                session_store=InMemorySessionStore(),
                system_prompt="System prompt",
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
