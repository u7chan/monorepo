"""Tests for types module."""

from simple_agent_poc.types import (
    AgentError,
    AuthenticationError,
    LLMError,
    Message,
    RateLimitError,
    Usage,
)


class TestAgentError:
    """Tests for AgentError exception."""

    def test_basic_error(self) -> None:
        """Test basic error creation."""
        error = AgentError("Something went wrong")
        assert str(error) == "Something went wrong"
        assert error.display_message == "Something went wrong"

    def test_error_with_display_message(self) -> None:
        """Test error with custom display message."""
        error = AgentError(
            message="Internal error details",
            display_message="User-friendly message",
        )
        assert str(error) == "Internal error details"
        assert error.display_message == "User-friendly message"


class TestAuthenticationError:
    """Tests for AuthenticationError exception."""

    def test_inheritance(self) -> None:
        """Test that AuthenticationError inherits from AgentError."""
        error = AuthenticationError("Auth failed")
        assert isinstance(error, AgentError)

    def test_error_message(self) -> None:
        """Test authentication error message."""
        error = AuthenticationError(
            message="API key invalid",
            display_message="Please check your API key",
        )
        assert error.display_message == "Please check your API key"


class TestRateLimitError:
    """Tests for RateLimitError exception."""

    def test_inheritance(self) -> None:
        """Test that RateLimitError inherits from AgentError."""
        error = RateLimitError("Rate limited")
        assert isinstance(error, AgentError)


class TestLLMError:
    """Tests for LLMError exception."""

    def test_inheritance(self) -> None:
        """Test that LLMError inherits from AgentError."""
        error = LLMError("LLM failed")
        assert isinstance(error, AgentError)


class TestMessageType:
    """Tests for Message TypedDict."""

    def test_create_message(self) -> None:
        """Test creating a message."""
        msg: Message = {"role": "user", "content": "Hello"}
        assert msg["role"] == "user"
        assert msg["content"] == "Hello"

    def test_assistant_message(self) -> None:
        """Test creating an assistant message."""
        msg: Message = {"role": "assistant", "content": "Hi there"}
        assert msg["role"] == "assistant"


class TestUsageType:
    """Tests for Usage TypedDict."""

    def test_create_usage(self) -> None:
        """Test creating usage stats."""
        usage: Usage = {
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "total_tokens": 30,
        }
        assert usage["prompt_tokens"] == 10
        assert usage["completion_tokens"] == 20
        assert usage["total_tokens"] == 30
