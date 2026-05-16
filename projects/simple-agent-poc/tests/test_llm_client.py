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
        mock_response.output_text = "Hello, world!"
        mock_response.usage.input_tokens = 10
        mock_response.usage.output_tokens = 5
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
            input=messages,
            model="gpt-5.4-nano",
            stream=False,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_passes_temperature(self, mock_responses: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.output_text = "Hello, world!"
        mock_response.usage.input_tokens = 10
        mock_response.usage.output_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano", temperature=0.2)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        client.complete(messages)

        mock_responses.assert_called_once_with(
            input=messages,
            model="gpt-5.4-nano",
            stream=False,
            temperature=0.2,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_omits_null_temperature(self, mock_responses: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.output_text = "Hello, world!"
        mock_response.usage.input_tokens = 10
        mock_response.usage.output_tokens = 5
        mock_response.usage.total_tokens = 15
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano", temperature=None)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        client.complete(messages)

        mock_responses.assert_called_once_with(
            input=messages,
            model="gpt-5.4-nano",
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

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_parses_tool_calls_from_output(
        self, mock_responses: MagicMock
    ) -> None:
        tool_call_item = MagicMock()
        tool_call_item.type = "function_call"
        tool_call_item.call_id = "call_001"
        tool_call_item.name = "concat"
        tool_call_item.arguments = '{"a":"1","b":"2"}'
        mock_response = MagicMock()
        mock_response.output_text = ""
        mock_response.usage.input_tokens = 20
        mock_response.usage.output_tokens = 15
        mock_response.usage.total_tokens = 35
        mock_response.output = [tool_call_item]
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "concat a and b"}]

        result = client.complete(messages)

        assert "tool_calls" in result
        assert result["tool_calls"] == [
            {
                "id": "call_001",
                "type": "function",
                "function": {
                    "name": "concat",
                    "arguments": '{"a":"1","b":"2"}',
                },
            }
        ]

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_parses_tool_calls_from_output_dict(
        self, mock_responses: MagicMock
    ) -> None:
        mock_response = MagicMock()
        mock_response.output_text = ""
        mock_response.usage.input_tokens = 20
        mock_response.usage.output_tokens = 15
        mock_response.usage.total_tokens = 35
        mock_response.output = [
            {
                "type": "function_call",
                "call_id": "call_002",
                "name": "get_current_time",
                "arguments": "",
            }
        ]
        mock_responses.return_value = mock_response

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "what time is it"}]

        result = client.complete(messages)

        assert "tool_calls" in result
        assert result["tool_calls"][0]["id"] == "call_002"
        assert result["tool_calls"][0]["function"]["name"] == "get_current_time"


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


class TestLiteLLMCompletionClientStream:
    """Tests for complete_stream method of LiteLLMCompletionClient."""

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_yields_content_deltas(
        self,
        mock_completion: MagicMock,
    ) -> None:
        chunk1 = MagicMock()
        chunk1.choices = [MagicMock()]
        chunk1.choices[0].delta.content = "Hello"
        chunk1.usage = None
        chunk2 = MagicMock()
        chunk2.choices = [MagicMock()]
        chunk2.choices[0].delta.content = ", world!"
        chunk2.usage = None
        empty_chunk = MagicMock()
        empty_chunk.choices = [MagicMock()]
        empty_chunk.choices[0].delta.content = ""
        empty_chunk.usage = None
        mock_completion.return_value = [chunk1, chunk2, empty_chunk]

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        result = list(client.complete_stream(messages))

        assert result == [
            {"content_delta": "Hello"},
            {"content_delta": ", world!"},
        ]
        mock_completion.assert_called_once_with(
            model="gpt-4",
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_yields_usage_from_last_chunk(
        self,
        mock_completion: MagicMock,
    ) -> None:
        usage_mock = MagicMock()
        usage_mock.prompt_tokens = 10
        usage_mock.completion_tokens = 5
        usage_mock.total_tokens = 15

        content_chunk = MagicMock()
        content_chunk.choices = [MagicMock()]
        content_chunk.choices[0].delta.content = "Hello"
        content_chunk.usage = None

        usage_chunk = MagicMock()
        usage_chunk.choices = [MagicMock()]
        usage_chunk.choices[0].delta.content = ""
        usage_chunk.usage = usage_mock

        mock_completion.return_value = [content_chunk, usage_chunk]

        client = LiteLLMCompletionClient(model="gpt-4")
        result = list(client.complete_stream([{"role": "user", "content": "Hi"}]))

        assert result == [
            {"content_delta": "Hello"},
            {
                "content_delta": None,
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        ]

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_passes_temperature(
        self,
        mock_completion: MagicMock,
    ) -> None:
        mock_completion.return_value = []

        client = LiteLLMCompletionClient(model="gpt-4", temperature=0.2)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        list(client.complete_stream(messages))

        mock_completion.assert_called_once_with(
            model="gpt-4",
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
            temperature=0.2,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_authentication_error(
        self,
        mock_completion: MagicMock,
    ) -> None:
        mock_completion.side_effect = LiteLLMAuthError(
            "Invalid API key",
            llm_provider="openai",
            model="gpt-4",
        )

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError):
            list(client.complete_stream(messages))

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_rate_limit_error(
        self,
        mock_completion: MagicMock,
    ) -> None:
        mock_completion.side_effect = LiteLLMRateLimitError(
            "Rate limit exceeded",
            llm_provider="openai",
            model="gpt-4",
        )

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(RateLimitError):
            list(client.complete_stream(messages))

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_generic_error(
        self,
        mock_completion: MagicMock,
    ) -> None:
        mock_completion.side_effect = ValueError("Something went wrong")

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(LLMError):
            list(client.complete_stream(messages))

    @patch("simple_agent_poc.adapters.llm.litellm_client.completion")
    def test_complete_stream_auth_from_generic_exception(
        self,
        mock_completion: MagicMock,
    ) -> None:
        mock_completion.side_effect = Exception("401 unauthorized")

        client = LiteLLMCompletionClient(model="gpt-4")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError):
            list(client.complete_stream(messages))


class TestLiteLLMResponsesClientStream:
    """Tests for complete_stream method of LiteLLMResponsesClient."""

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_yields_content_deltas(
        self,
        mock_responses: MagicMock,
    ) -> None:
        event1 = MagicMock()
        event1.delta = "Hello"
        del event1.response
        event2 = MagicMock()
        event2.delta = ", world!"
        del event2.response
        event3 = MagicMock()
        del event3.delta
        del event3.response
        mock_responses.return_value = [event1, event2, event3]

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        result = list(client.complete_stream(messages))

        assert result == [
            {"content_delta": "Hello"},
            {"content_delta": ", world!"},
        ]
        mock_responses.assert_called_once_with(
            input=messages,
            model="gpt-5.4-nano",
            stream=True,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_yields_usage_from_last_event(
        self,
        mock_responses: MagicMock,
    ) -> None:
        usage_mock = MagicMock()
        usage_mock.input_tokens = 10
        usage_mock.output_tokens = 5
        usage_mock.total_tokens = 15

        content_event = MagicMock()
        content_event.delta = "Hello"
        del content_event.response

        usage_event = MagicMock()
        del usage_event.delta
        usage_event.response = MagicMock()
        usage_event.response.usage = usage_mock

        mock_responses.return_value = [content_event, usage_event]

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        result = list(client.complete_stream([{"role": "user", "content": "Hi"}]))

        assert result == [
            {"content_delta": "Hello"},
            {
                "content_delta": None,
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        ]

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_passes_temperature(
        self,
        mock_responses: MagicMock,
    ) -> None:
        mock_responses.return_value = []

        client = LiteLLMResponsesClient(model="gpt-5.4-nano", temperature=0.2)
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        list(client.complete_stream(messages))

        mock_responses.assert_called_once_with(
            input=messages,
            model="gpt-5.4-nano",
            stream=True,
            temperature=0.2,
        )

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_authentication_error(
        self,
        mock_responses: MagicMock,
    ) -> None:
        mock_responses.side_effect = LiteLLMAuthError(
            "Invalid API key",
            llm_provider="openai",
            model="gpt-5.4-nano",
        )

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(AuthenticationError):
            list(client.complete_stream(messages))

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_generic_error(
        self,
        mock_responses: MagicMock,
    ) -> None:
        mock_responses.side_effect = ValueError("Something went wrong")

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "Hi"}]

        with pytest.raises(LLMError):
            list(client.complete_stream(messages))

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_yields_tool_call_delta_from_output_item_added(
        self,
        mock_responses: MagicMock,
    ) -> None:
        item = MagicMock()
        item.type = "function_call"
        item.call_id = "call_001"
        item.name = "concat"
        item.arguments = ""
        event = MagicMock()
        event.type = "response.output_item.added"
        event.output_index = 0
        event.item = item
        mock_responses.return_value = [event]

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "concat a b"}]
        result = list(client.complete_stream(messages))

        assert len(result) == 1
        assert result[0]["content_delta"] is None
        td = result[0]["tool_call_delta"]
        assert td is not None
        assert td["index"] == 0
        assert td["id"] == "call_001"
        assert td["function"]["name"] == "concat"

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_yields_tool_call_delta_from_arguments_delta(
        self,
        mock_responses: MagicMock,
    ) -> None:
        event = MagicMock()
        event.type = "response.function_call_arguments.delta"
        event.output_index = 0
        event.item_id = "call_001"
        event.delta = '{"a":"1"}'
        mock_responses.return_value = [event]

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        messages: list[Message] = [{"role": "user", "content": "concat a b"}]
        result = list(client.complete_stream(messages))

        assert len(result) == 1
        assert result[0]["content_delta"] is None
        td = result[0]["tool_call_delta"]
        assert td is not None
        assert td["index"] == 0
        assert td["id"] == "call_001"
        assert td["function"]["name"] is None
        assert td["function"]["arguments"] == '{"a":"1"}'

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_tool_call_and_text_interleaved(
        self,
        mock_responses: MagicMock,
    ) -> None:
        item = MagicMock()
        item.type = "function_call"
        item.call_id = "call_001"
        item.name = "concat"
        item.arguments = ""
        tool_event = MagicMock()
        tool_event.type = "response.output_item.added"
        tool_event.output_index = 0
        tool_event.item = item

        text_event = MagicMock()
        del text_event.response
        text_event.type = "response.output_text.delta"
        text_event.delta = "Hello"

        mock_responses.return_value = [tool_event, text_event]

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        result = list(client.complete_stream([]))

        assert len(result) == 2
        assert result[0]["tool_call_delta"] is not None
        assert result[1]["content_delta"] == "Hello"
