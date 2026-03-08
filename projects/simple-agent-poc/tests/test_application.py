"""Tests for application use cases and DTOs."""

from unittest.mock import MagicMock

from simple_agent_poc.application import (
    RunAgentRequest,
    RunAgentResponse,
    RunAgentUseCase,
)
from simple_agent_poc.types import LLMResponse


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

    def test_execute_delegates_to_agent_and_returns_dto(self) -> None:
        agent = MagicMock()
        agent.process_user_input.return_value = {
            "content": "Hello, user!",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.85,
        }

        use_case = RunAgentUseCase(agent)
        response = use_case.execute(
            RunAgentRequest(message="Hello", session_id="session-1")
        )

        agent.process_user_input.assert_called_once_with("Hello")
        assert response == RunAgentResponse(
            message="Hello, user!",
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            model="gpt-4o-mini",
            response_time=0.85,
            session_id="session-1",
        )
