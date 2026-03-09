"""Tests for the HTTP API adapter."""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from simple_agent_poc.api import create_app
from simple_agent_poc.application import RunAgentResponse


class TestAPI:
    """Tests for the FastAPI entrypoint."""

    def test_chat_returns_use_case_response(self) -> None:
        run_agent = MagicMock()
        run_agent.execute.return_value = RunAgentResponse(
            message="Hello, user!",
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            model="gpt-4o-mini",
            response_time=0.85,
        )
        use_case_factory = MagicMock(return_value=run_agent)
        app = create_app(use_case_factory=use_case_factory)
        client = TestClient(app)

        response = client.post("/api/chat", json={"message": "Hello"})

        assert response.status_code == 200
        assert response.json() == {
            "message": "Hello, user!",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.85,
        }
        use_case_factory.assert_called_once_with()
        request = run_agent.execute.call_args.args[0]
        assert request.message == "Hello"

    def test_chat_rejects_missing_message(self) -> None:
        app = create_app(use_case_factory=MagicMock())
        client = TestClient(app)

        response = client.post("/api/chat", json={})

        assert response.status_code == 422

    def test_chat_rejects_blank_message(self) -> None:
        app = create_app(use_case_factory=MagicMock())
        client = TestClient(app)

        response = client.post("/api/chat", json={"message": "   "})

        assert response.status_code == 422

    def test_chat_uses_new_use_case_per_request(self) -> None:
        first_use_case = MagicMock()
        first_use_case.execute.return_value = RunAgentResponse(
            message="First",
            usage={
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
            model="gpt-4o-mini",
            response_time=0.1,
        )
        second_use_case = MagicMock()
        second_use_case.execute.return_value = RunAgentResponse(
            message="Second",
            usage={
                "prompt_tokens": 2,
                "completion_tokens": 2,
                "total_tokens": 4,
            },
            model="gpt-4o-mini",
            response_time=0.2,
        )
        use_case_factory = MagicMock(side_effect=[first_use_case, second_use_case])
        app = create_app(use_case_factory=use_case_factory)
        client = TestClient(app)

        first_response = client.post("/api/chat", json={"message": "Hello"})
        second_response = client.post("/api/chat", json={"message": "Again"})

        assert first_response.status_code == 200
        assert second_response.status_code == 200
        assert first_response.json()["message"] == "First"
        assert second_response.json()["message"] == "Second"
        assert use_case_factory.call_count == 2
