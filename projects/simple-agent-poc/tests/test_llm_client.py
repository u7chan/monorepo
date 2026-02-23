"""Tests for llm_client module."""

from unittest.mock import MagicMock, patch

import pytest
from litellm.exceptions import (
    AuthenticationError as LiteLLMAuthError,
    RateLimitError as LiteLLMRateLimitError,
)

from simple_agent_poc.llm_client import LiteLLMClient
from simple_agent_poc.types import (
    AuthenticationError,
    LLMError,
    Message,
    RateLimitError,
)


class TestLiteLLMClient:
    """Tests for LiteLLMClient class."""

    def test_init(self) -> None:
        """Test client initialization."""
        client = LiteLLMClient(model="gpt-4")
        assert client.model == "gpt-4"

    @patch("simple_agent_poc.llm_client.completion")
    def test_complete_success(self, mock_completion: MagicMock) -> None:
        """Test successful completion."""
        # Setup mock response
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_completion.return_value = mock_response

        client = LiteLLMClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        result = client.complete(messages)

        assert result["content"] == "Hello, world!"
        assert result["usage"]["prompt_tokens"] == 10
        assert result["usage"]["completion_tokens"] == 5
        assert result["usage"]["total_tokens"] == 15

        mock_completion.assert_called_once_with(
            model="gpt-4",
            messages=messages,
            stream=False,
        )

    @patch("simple_agent_poc.llm_client.completion")
    def test_complete_authentication_error(self, mock_completion: MagicMock) -> None:
        """Test handling of authentication error."""
        mock_completion.side_effect = LiteLLMAuthError(
            "Invalid API key",
            llm_provider="openai",
            model="gpt-4",
        )

        client = LiteLLMClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError) as exc_info:
            client.complete(messages)

        assert "Authentication failed" in exc_info.value.display_message
        assert "Invalid API key" in str(exc_info.value)

    @patch("simple_agent_poc.llm_client.completion")
    def test_complete_rate_limit_error(self, mock_completion: MagicMock) -> None:
        """Test handling of rate limit error."""
        mock_completion.side_effect = LiteLLMRateLimitError(
            "Rate limit exceeded",
            llm_provider="openai",
            model="gpt-4",
        )

        client = LiteLLMClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(RateLimitError) as exc_info:
            client.complete(messages)

        assert "Rate limit exceeded" in exc_info.value.display_message

    @patch("simple_agent_poc.llm_client.completion")
    def test_complete_generic_error(self, mock_completion: MagicMock) -> None:
        """Test handling of generic error."""
        mock_completion.side_effect = ValueError("Something went wrong")

        client = LiteLLMClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(LLMError) as exc_info:
            client.complete(messages)

        assert "An error occurred" in exc_info.value.display_message

    @patch("simple_agent_poc.llm_client.completion")
    def test_complete_auth_error_from_generic_exception(
        self,
        mock_completion: MagicMock,
    ) -> None:
        """Test that generic exceptions with auth keywords are converted."""
        mock_completion.side_effect = Exception("401 unauthorized: invalid api key")

        client = LiteLLMClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError) as exc_info:
            client.complete(messages)

        assert "Authentication failed" in exc_info.value.display_message

    @patch("simple_agent_poc.llm_client.completion")
    def test_complete_multiple_messages(self, mock_completion: MagicMock) -> None:
        """Test completion with multiple messages."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Response"
        mock_response.usage.prompt_tokens = 20
        mock_response.usage.completion_tokens = 10
        mock_response.usage.total_tokens = 30
        mock_completion.return_value = mock_response

        client = LiteLLMClient(model="gpt-4")
        messages: list[Message] = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi"},
            {"role": "user", "content": "How are you?"},
        ]

        result = client.complete(messages)

        assert result["content"] == "Response"
        mock_completion.assert_called_once_with(
            model="gpt-4",
            messages=messages,
            stream=False,
        )
