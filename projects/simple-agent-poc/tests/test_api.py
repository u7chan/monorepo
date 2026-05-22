"""Tests for the HTTP API adapter."""

from collections.abc import Iterator

from fastapi.testclient import TestClient

from simple_agent_poc.adapters.http.api import create_app
from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.adapters.tools.ask_user import (
    TOOL_DEFINITION as ASK_USER_TOOL_DEF,
)
from simple_agent_poc.adapters.tools.ask_user import execute as ask_user_execute
from simple_agent_poc.adapters.tools.registry import BuiltinToolRegistry
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import LLMStreamChunk, Message

from tests.helpers import _choice_questions_args


class StubLLMClient:
    """Deterministic LLM stub for HTTP adapter tests."""

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[list[Message]] = []

    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools=None,
    ) -> Iterator[LLMStreamChunk]:
        self.calls.append(list(messages))
        yield LLMStreamChunk(content_delta=self.reply)
        yield LLMStreamChunk(
            content_delta=None,
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
        )


def unused_use_case_factory() -> RunAgentUseCase:
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


def _parse_sse_events(streaming_response) -> list[dict]:
    """Parse an SSE streaming response into a list of {type, data} dicts."""
    events = []
    current_type = ""
    for line in streaming_response.iter_lines():
        if line.startswith("event: "):
            current_type = line[7:]
        elif line.startswith("data: "):
            import json

            data = json.loads(line[6:])
            events.append({"type": current_type, "data": data})
            current_type = ""
    return events


class TestAPI:
    """Tests for the FastAPI adapter."""

    def test_chat_returns_streaming_response_with_session_id(self) -> None:
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
        events = _parse_sse_events(response)
        delta_events = [e for e in events if e["type"] == "delta"]
        complete_events = [e for e in events if e["type"] == "complete"]
        done_events = [e for e in events if e["type"] == "done"]
        assert len(delta_events) == 1
        assert delta_events[0]["data"]["content"] == "Hello, user!"
        assert len(complete_events) == 1
        assert complete_events[0]["data"]["session_id"]
        assert len(done_events) == 1

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

        first_client = TestClient(
            create_app(
                use_case_factory=lambda: RunAgentUseCase(
                    llm_client_factory=lambda _agent_definition: StubLLMClient(
                        reply="First"
                    ),
                    session_store=store,
                    agent_definitions=build_registry(),
                )
            )
        )

        first_response = first_client.post("/api/chat", json={"message": "Hello"})
        assert first_response.status_code == 200
        events = _parse_sse_events(first_response)
        complete_events = [e for e in events if e["type"] == "complete"]
        session_id = complete_events[0]["data"]["session_id"]

        second_client = TestClient(
            create_app(
                use_case_factory=lambda: RunAgentUseCase(
                    llm_client_factory=lambda _agent_definition: StubLLMClient(
                        reply="Second"
                    ),
                    session_store=store,
                    agent_definitions=build_registry(),
                )
            )
        )

        second_response = second_client.post(
            "/api/chat",
            headers={"Session-Id": session_id},
            json={"message": "Again"},
        )
        assert second_response.status_code == 200

    def test_chat_accepts_body_session_id_for_compatibility(self) -> None:
        store = InMemorySessionStore()

        first_client = TestClient(
            create_app(
                use_case_factory=lambda: RunAgentUseCase(
                    llm_client_factory=lambda _agent_definition: StubLLMClient(
                        reply="First"
                    ),
                    session_store=store,
                    agent_definitions=build_registry(),
                )
            )
        )

        first_response = first_client.post("/api/chat", json={"message": "Hello"})
        assert first_response.status_code == 200
        events = _parse_sse_events(first_response)
        complete_events = [e for e in events if e["type"] == "complete"]
        session_id = complete_events[0]["data"]["session_id"]

        second_client = TestClient(
            create_app(
                use_case_factory=lambda: RunAgentUseCase(
                    llm_client_factory=lambda _agent_definition: StubLLMClient(
                        reply="Second"
                    ),
                    session_store=store,
                    agent_definitions=build_registry(),
                )
            )
        )

        second_response = second_client.post(
            "/api/chat",
            json={"message": "Again", "session_id": session_id},
        )
        assert second_response.status_code == 200

    def test_chat_returns_404_for_unknown_session_header(self) -> None:
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: StubLLMClient(
                    reply="Hello"
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
        events = _parse_sse_events(response)
        error_events = [e for e in events if e["type"] == "error"]
        assert len(error_events) == 1
        assert "not found" in error_events[0]["data"]["detail"].lower()

    def test_chat_returns_400_for_conflicting_session_transports(self) -> None:
        app = create_app(use_case_factory=unused_use_case_factory)
        client = TestClient(app)

        response = client.post(
            "/api/chat",
            headers={"Session-Id": "header-session"},
            json={"message": "Hello", "session_id": "body-session"},
        )
        assert response.status_code == 400

    def test_chat_uses_body_agent_id(self) -> None:
        llm_client = StubLLMClient(reply="Research result")
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

    def test_chat_returns_400_for_unknown_agent_id(self) -> None:
        app = create_app(use_case_factory=unused_use_case_factory)
        client = TestClient(app)

        response = client.post(
            "/api/chat",
            json={"message": "Hello", "agent_id": "missing"},
        )
        events = _parse_sse_events(response)
        error_events = [e for e in events if e["type"] == "error"]
        assert len(error_events) == 1

    def test_chat_returns_400_when_agent_changes_for_session(self) -> None:
        store = InMemorySessionStore()

        first_client = TestClient(
            create_app(
                use_case_factory=lambda: RunAgentUseCase(
                    llm_client_factory=lambda _agent_definition: StubLLMClient(
                        reply="First"
                    ),
                    session_store=store,
                    agent_definitions=build_registry(),
                )
            )
        )

        first_response = first_client.post("/api/chat", json={"message": "Hello"})
        assert first_response.status_code == 200
        events = _parse_sse_events(first_response)
        complete_events = [e for e in events if e["type"] == "complete"]
        session_id = complete_events[0]["data"]["session_id"]

        second_response = first_client.post(
            "/api/chat",
            headers={"Session-Id": session_id},
            json={"message": "Again", "agent_id": "researcher"},
        )
        events2 = _parse_sse_events(second_response)
        error_events = [e for e in events2 if e["type"] == "error"]
        assert len(error_events) == 1

    def test_chat_switch_to_continue_without_session_header(self) -> None:
        store = InMemorySessionStore()
        llm_client = StubLLMClient(reply="Hello")
        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: llm_client,
                session_store=store,
                agent_definitions=build_registry(),
            )
        )
        client = TestClient(app)

        response1 = client.post("/api/chat", json={"message": "Hello"})
        assert response1.status_code == 200
        events1 = _parse_sse_events(response1)
        complete_events = [e for e in events1 if e["type"] == "complete"]
        session_id = complete_events[0]["data"]["session_id"]

        response2 = client.post(
            "/api/chat", json={"message": "Again", "session_id": session_id}
        )
        assert response2.status_code == 200

    def test_agents_list_endpoint(self) -> None:
        app = create_app()
        client = TestClient(app)

        response = client.get("/api/agents")
        assert response.status_code == 200
        data = response.json()
        assert len(data["agents"]) == 2
        agent_ids = {a["id"] for a in data["agents"]}
        assert "default" in agent_ids

    def test_test_page_endpoint(self) -> None:
        app = create_app()
        client = TestClient(app)

        response = client.get("/")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "simple-agent-poc" in response.text

    def test_chat_stream_pause_includes_choice_options(self) -> None:
        tool_executor = BuiltinToolRegistry()
        tool_executor.register(ASK_USER_TOOL_DEF, ask_user_execute)

        class AskUserStubLLMClient:
            def complete_stream(
                self,
                messages: list[Message],
                *,
                tools=None,
            ) -> Iterator[LLMStreamChunk]:
                yield LLMStreamChunk(content_delta=None)
                yield LLMStreamChunk(
                    content_delta=None,
                    tool_call_delta={
                        "index": 0,
                        "id": "call_001",
                        "type": "function",
                        "function": {
                            "name": "ask_user",
                            "arguments": _choice_questions_args(),
                        },
                    },
                )
                yield LLMStreamChunk(
                    content_delta=None,
                    usage={
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                )

        app = create_app(
            use_case_factory=lambda: RunAgentUseCase(
                llm_client_factory=lambda _agent_definition: AskUserStubLLMClient(),
                session_store=InMemorySessionStore(),
                agent_definitions=build_registry_with_ask_user(),
                tool_executor=tool_executor,
                is_api_context=True,
            )
        )
        client = TestClient(app)

        response = client.post("/api/chat", json={"message": "Hello"})
        assert response.status_code == 200

        events = _parse_sse_events(response)
        paused_events = [e for e in events if e["type"] == "paused"]
        assert len(paused_events) == 1
        paused_data = paused_events[0]["data"]
        assert paused_data["session_id"]
        assert paused_data["call_id"] == "call_001"
        questions = paused_data["questions"]
        assert len(questions) == 1
        assert questions[0]["type"] == "choice"
        assert len(questions[0]["options"]) == 2
        assert questions[0]["options"][0]["label"] == "PostgreSQL"


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
