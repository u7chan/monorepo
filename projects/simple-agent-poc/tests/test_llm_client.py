"""Tests for LiteLLM client adapter."""

from unittest.mock import MagicMock, patch

import pytest
from litellm.exceptions import (
    AuthenticationError as LiteLLMAuthError,
    RateLimitError as LiteLLMRateLimitError,
)

from simple_agent_poc.adapters.llm.litellm_client import (
    LiteLLMClientFactory,
    LiteLLMCompletionClient,
    LiteLLMResponsesClient,
)
from simple_agent_poc.core.agent_definition import AgentDefinition
from simple_agent_poc.core.types import (
    AuthenticationError,
    LLMError,
    Message,
    RateLimitError,
)


class TestLiteLLMCompletionClient:
    """Tests for LiteLLMCompletionClient class."""

    def test_init(self) -> None:
        client = LiteLLMCompletionClient(model="gpt-4", temperature=0.2)
        assert client.model == "gpt-4"
        assert client.temperature == 0.2

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_success(self, mock_completion: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_completion.return_value = mock_response

        client = LiteLLMCompletionClient(model="gpt-4")
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

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_passes_temperature(self, mock_completion: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_completion.return_value = mock_response

        client = LiteLLMCompletionClient(model="gpt-4", temperature=0.2)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        client.complete(messages)

        mock_completion.assert_called_once_with(
            model="gpt-4",
            messages=messages,
            stream=False,
            temperature=0.2,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_omits_null_temperature(self, mock_completion: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_completion.return_value = mock_response

        client = LiteLLMCompletionClient(model="gpt-5.4-mini", temperature=None)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        client.complete(messages)

        mock_completion.assert_called_once_with(
            model="gpt-5.4-mini",
            messages=messages,
            stream=False,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_authentication_error(self, mock_completion: MagicMock) -> None:
        mock_completion.side_effect = LiteLLMAuthError(
            "Invalid API key",
            llm_provider="openai",
            model="gpt-4",
        )

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError) as exc_info:
            client.complete(messages)

        assert "Authentication failed" in exc_info.value.display_message
        assert "Invalid API key" in str(exc_info.value)

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_rate_limit_error(self, mock_completion: MagicMock) -> None:
        mock_completion.side_effect = LiteLLMRateLimitError(
            "Rate limit exceeded",
            llm_provider="openai",
            model="gpt-4",
        )

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(RateLimitError) as exc_info:
            client.complete(messages)

        assert "Rate limit exceeded" in exc_info.value.display_message

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_generic_error(self, mock_completion: MagicMock) -> None:
        mock_completion.side_effect = ValueError("Something went wrong")

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(LLMError) as exc_info:
            client.complete(messages)

        assert "An error occurred" in exc_info.value.display_message

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_auth_error_from_generic_exception(
        self,
        mock_completion: MagicMock,
    ) -> None:
        mock_completion.side_effect = Exception("401 unauthorized: invalid api key")

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError) as exc_info:
            client.complete(messages)

        assert "Authentication failed" in exc_info.value.display_message

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_multiple_messages(self, mock_completion: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Response"
        mock_response.usage.prompt_tokens = 20
        mock_response.usage.completion_tokens = 10
        mock_response.usage.total_tokens = 30
        mock_completion.return_value = mock_response

        client = LiteLLMCompletionClient(model="gpt-4")
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


class TestLiteLLMResponsesClient:
    """Tests for LiteLLMResponsesClient class."""

    def test_init(self) -> None:
        client = LiteLLMResponsesClient(model="gpt-5.4-nano", temperature=0.2)
        assert client.model == "gpt-5.4-nano"
        assert client.temperature == 0.2

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_success(self, mock_responses: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        result = client.complete(messages)

        assert result["content"] == "Hello, world!"
        assert result["usage"]["prompt_tokens"] == 10
        assert result["usage"]["completion_tokens"] == 5
        assert result["usage"]["total_tokens"] == 15

        mock_responses.assert_called_once_with(
            model="gpt-5.4-nano",
            messages=messages,
            stream=False,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_passes_temperature(self, mock_responses: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano", temperature=0.2)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        client.complete(messages)

        mock_responses.assert_called_once_with(
            model="gpt-5.4-nano",
            messages=messages,
            stream=False,
            temperature=0.2,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_omits_null_temperature(self, mock_responses: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hello, world!"
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano", temperature=None)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        client.complete(messages)

        mock_responses.assert_called_once_with(
            model="gpt-5.4-nano",
            messages=messages,
            stream=False,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_authentication_error(self, mock_responses: MagicMock) -> None:
        mock_responses.side_effect = LiteLLMAuthError(
            "Invalid API key",
            llm_provider="openai",
            model="gpt-5.4-nano",
        )

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError) as exc_info:
            client.complete(messages)

        assert "Authentication failed" in exc_info.value.display_message
        assert "Invalid API key" in str(exc_info.value)

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_rate_limit_error(self, mock_responses: MagicMock) -> None:
        mock_responses.side_effect = LiteLLMRateLimitError(
            "Rate limit exceeded",
            llm_provider="openai",
            model="gpt-5.4-nano",
        )

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(RateLimitError) as exc_info:
            client.complete(messages)

        assert "Rate limit exceeded" in exc_info.value.display_message

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_generic_error(self, mock_responses: MagicMock) -> None:
        mock_responses.side_effect = ValueError("Something went wrong")

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(LLMError) as exc_info:
            client.complete(messages)

        assert "An error occurred" in exc_info.value.display_message


class TestLiteLLMClientFactory:
    """Tests for LiteLLMClientFactory class."""

    def test_factory_creates_completion_client_by_default(self) -> None:
        factory = LiteLLMClientFactory()
        agent_definition = AgentDefinition(
            agent_id="default",
            model="gpt-4",
            system_prompt="Prompt",
            temperature=0.1,
        )

        client = factory(agent_definition)

        assert isinstance(client, LiteLLMCompletionClient)
        assert client.model == "gpt-4"
        assert client.temperature == 0.1

    def test_factory_creates_completion_client_explicitly(self) -> None:
        factory = LiteLLMClientFactory()
        agent_definition = AgentDefinition(
            agent_id="default",
            model="gpt-4",
            system_prompt="Prompt",
            temperature=0.1,
            api_type="completion",
        )

        client = factory(agent_definition)

        assert isinstance(client, LiteLLMCompletionClient)
        assert client.model == "gpt-4"
        assert client.temperature == 0.1

    def test_factory_creates_responses_client(self) -> None:
        factory = LiteLLMClientFactory()
        agent_definition = AgentDefinition(
            agent_id="gpt54",
            model="gpt-5.4-nano",
            system_prompt="Prompt",
            temperature=0.2,
            api_type="responses",
        )

        client = factory(agent_definition)

        assert isinstance(client, LiteLLMResponsesClient)
        assert client.model == "gpt-5.4-nano"
        assert client.temperature == 0.2

    def test_factory_creates_responses_client_without_temperature(self) -> None:
        factory = LiteLLMClientFactory()
        agent_definition = AgentDefinition(
            agent_id="gpt54",
            model="gpt-5.4-nano",
            system_prompt="Prompt",
            api_type="responses",
        )

        client = factory(agent_definition)

        assert isinstance(client, LiteLLMResponsesClient)
        assert client.model == "gpt-5.4-nano"
        assert client.temperature is None
