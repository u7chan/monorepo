"""Tests for application DTOs and use cases."""

from unittest.mock import MagicMock

import pytest

from simple_agent_poc.adapters.session_store.in_memory import InMemorySessionStore
from simple_agent_poc.application.dto import RunAgentRequest, RunAgentResponse
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.core.types import LLMResponse, SessionNotFoundError, ValidationError


class TestRunAgentRequest:
    """Tests for request DTO."""

    def test_defaults_session_id_to_none(self) -> None:
        request = RunAgentRequest(message="Hello")

        assert request.message == "Hello"
        assert request.session_id is None


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
        use_case = RunAgentUseCase(
            llm_client=llm_client,
            session_store=store,
            system_prompt="System prompt",
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
        stored_session = store.get(response.session_id)
        assert stored_session is not None
        assert stored_session.messages[-1] == {
            "role": "assistant",
            "content": "Hello, user!",
        }

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
        first_use_case = RunAgentUseCase(
            llm_client=first_client,
            session_store=store,
            system_prompt="System prompt",
        )
        second_use_case = RunAgentUseCase(
            llm_client=second_client,
            session_store=store,
            system_prompt="System prompt",
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

    def test_execute_rejects_unknown_session(self) -> None:
        use_case = RunAgentUseCase(
            llm_client=MagicMock(),
            session_store=InMemorySessionStore(),
            system_prompt="System prompt",
        )

        with pytest.raises(SessionNotFoundError, match="Session not found"):
            use_case.execute(
                RunAgentRequest(message="Hello", session_id="missing-session")
            )

    def test_execute_rejects_blank_message(self) -> None:
        use_case = RunAgentUseCase(
            llm_client=MagicMock(),
            session_store=InMemorySessionStore(),
            system_prompt="System prompt",
        )

        with pytest.raises(ValidationError, match="message must not be blank"):
            use_case.execute(RunAgentRequest(message="   "))
