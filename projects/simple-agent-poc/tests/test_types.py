"""Tests for core types module."""

from simple_agent_poc.core.types import (
    AgentError,
    AuthenticationError,
    LLMError,
    Message,
    RateLimitError,
    SessionNotFoundError,
    Usage,
)


class TestAgentError:
    """Tests for AgentError exception."""

    def test_basic_error(self) -> None:
        error = AgentError("Something went wrong")
        assert str(error) == "Something went wrong"
        assert error.display_message == "Something went wrong"

    def test_error_with_display_message(self) -> None:
        error = AgentError(
            message="Internal error details",
            display_message="User-friendly message",
        )
        assert str(error) == "Internal error details"
        assert error.display_message == "User-friendly message"


class TestAuthenticationError:
    """Tests for AuthenticationError exception."""

    def test_inheritance(self) -> None:
        error = AuthenticationError("Auth failed")
        assert isinstance(error, AgentError)


class TestRateLimitError:
    """Tests for RateLimitError exception."""

    def test_inheritance(self) -> None:
        error = RateLimitError("Rate limited")
        assert isinstance(error, AgentError)


class TestLLMError:
    """Tests for LLMError exception."""

    def test_inheritance(self) -> None:
        error = LLMError("LLM failed")
        assert isinstance(error, AgentError)


class TestSessionNotFoundError:
    """Tests for SessionNotFoundError exception."""

    def test_inheritance(self) -> None:
        error = SessionNotFoundError("Missing session")
        assert isinstance(error, AgentError)


class TestMessageType:
    """Tests for Message TypedDict."""

    def test_create_message(self) -> None:
        msg: Message = {"role": "user", "content": "Hello"}
        assert msg["role"] == "user"
        assert msg["content"] == "Hello"

    def test_assistant_message(self) -> None:
        msg: Message = {"role": "assistant", "content": "Hi there"}
        assert msg["role"] == "assistant"


class TestUsageType:
    """Tests for Usage TypedDict."""

    def test_create_usage(self) -> None:
        usage: Usage = {
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "total_tokens": 30,
        }
        assert usage["prompt_tokens"] == 10
        assert usage["completion_tokens"] == 20
        assert usage["total_tokens"] == 30
