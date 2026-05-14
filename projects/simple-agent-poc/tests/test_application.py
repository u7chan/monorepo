"""Tests for application DTOs and use cases."""

from unittest.mock import MagicMock

import pytest

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import RunAgentRequest, RunAgentResponse
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry
from simple_agent_poc.core.types import (
    LLMResponse,
    SessionNotFoundError,
    ValidationError,
)


class TestRunAgentRequest:
    """Tests for request DTO."""

    def test_defaults_session_id_to_none(self) -> None:
        request = RunAgentRequest(message="Hello")

        assert request.message == "Hello"
        assert request.session_id is None
        assert request.agent_id == "default"


class TestRunAgentResponse:
    """Tests for response DTO."""

    def test_from_llm_response(self) -> None:
        llm_response: LLMResponse = {
            "content": "Hello, user!",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.85,
        }

        response = RunAgentResponse.from_llm_response(
            llm_response,
            session_id="session-1",
        )

        assert response.message == "Hello, user!"
        assert response.usage == llm_response["usage"]
        assert response.model == "gpt-4o-mini"
        assert response.response_time == 0.85
        assert response.session_id == "session-1"


class TestRunAgentUseCase:
    """Tests for the reusable agent execution path."""

    def build_registry(self) -> AgentDefinitionRegistry:
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
                        "temperature": 0.1,
                        "tools": [],
                    },
                }
            }
        )

    def test_execute_creates_new_session_and_saves_it(self) -> None:
        llm_client = MagicMock()
        llm_client.complete.return_value = {
            "content": "Hello, user!",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.85,
        }
        store = InMemorySessionStore()
        llm_client_factory = MagicMock(return_value=llm_client)
        use_case = RunAgentUseCase(
            llm_client_factory=llm_client_factory,
            session_store=store,
            agent_definitions=self.build_registry(),
        )

        response = use_case.execute(RunAgentRequest(message="Hello"))

        assert response == RunAgentResponse(
            message="Hello, user!",
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            model="gpt-4o-mini",
            response_time=0.85,
            session_id=response.session_id,
        )
        assert response.session_id
        llm_client.complete.assert_called_once_with(
            [
                {"role": "system", "content": "System prompt"},
                {"role": "user", "content": "Hello"},
            ]
        )
        llm_client_factory.assert_called_once()
        assert llm_client_factory.call_args.args[0].agent_id == "default"
        stored_session = store.get(response.session_id)
        assert stored_session is not None
        assert stored_session.agent_id == "default"
        assert stored_session.messages[-1] == {
            "role": "assistant",
            "content": "Hello, user!",
        }

    def test_execute_uses_requested_agent_definition(self) -> None:
        llm_client = MagicMock()
        llm_client.complete.return_value = {
            "content": "Research reply",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "research-model",
            "response_time": 0.85,
        }
        llm_client_factory = MagicMock(return_value=llm_client)
        use_case = RunAgentUseCase(
            llm_client_factory=llm_client_factory,
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        response = use_case.execute(
            RunAgentRequest(message="Hello", agent_id="researcher")
        )

        assert response.model == "research-model"
        llm_client_factory.assert_called_once()
        assert llm_client_factory.call_args.args[0].agent_id == "researcher"
        llm_client.complete.assert_called_once_with(
            [
                {"role": "system", "content": "Research prompt"},
                {"role": "user", "content": "Hello"},
            ]
        )

    def test_execute_reuses_existing_session(self) -> None:
        first_client = MagicMock()
        first_client.complete.return_value = {
            "content": "First reply",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.2,
        }
        second_client = MagicMock()
        second_client.complete.return_value = {
            "content": "Second reply",
            "usage": {
                "prompt_tokens": 20,
                "completion_tokens": 8,
                "total_tokens": 28,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.3,
        }
        store = InMemorySessionStore()
        first_factory = MagicMock(return_value=first_client)
        second_factory = MagicMock(return_value=second_client)
        first_use_case = RunAgentUseCase(
            llm_client_factory=first_factory,
            session_store=store,
            agent_definitions=self.build_registry(),
        )
        second_use_case = RunAgentUseCase(
            llm_client_factory=second_factory,
            session_store=store,
            agent_definitions=self.build_registry(),
        )

        first_response = first_use_case.execute(RunAgentRequest(message="Hello"))
        second_response = second_use_case.execute(
            RunAgentRequest(message="Again", session_id=first_response.session_id)
        )

        assert second_response.session_id == first_response.session_id
        second_client.complete.assert_called_once_with(
            [
                {"role": "system", "content": "System prompt"},
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "First reply"},
                {"role": "user", "content": "Again"},
            ]
        )

    def test_execute_rejects_agent_change_for_existing_session(self) -> None:
        llm_client = MagicMock()
        llm_client.complete.return_value = {
            "content": "First reply",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "default-model",
            "response_time": 0.2,
        }
        store = InMemorySessionStore()
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=llm_client),
            session_store=store,
            agent_definitions=self.build_registry(),
        )

        first_response = use_case.execute(RunAgentRequest(message="Hello"))

        with pytest.raises(ValidationError, match="agent_id cannot be changed"):
            use_case.execute(
                RunAgentRequest(
                    message="Again",
                    session_id=first_response.session_id,
                    agent_id="researcher",
                )
            )

    def test_execute_rejects_unknown_session(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=MagicMock()),
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        with pytest.raises(SessionNotFoundError, match="Session not found"):
            use_case.execute(
                RunAgentRequest(message="Hello", session_id="missing-session")
            )

    def test_execute_rejects_blank_message(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=MagicMock()),
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        with pytest.raises(ValidationError, match="message must not be blank"):
            use_case.execute(RunAgentRequest(message="   "))

    def test_execute_rejects_unknown_agent_id(self) -> None:
        use_case = RunAgentUseCase(
            llm_client_factory=MagicMock(return_value=MagicMock()),
            session_store=InMemorySessionStore(),
            agent_definitions=self.build_registry(),
        )

        with pytest.raises(ValidationError, match="Unknown agent_id: missing"):
            use_case.execute(RunAgentRequest(message="Hello", agent_id="missing"))
