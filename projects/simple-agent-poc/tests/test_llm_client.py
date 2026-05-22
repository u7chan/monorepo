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
        event.item_id = "fc_001"
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
        assert td["id"] is None
        assert td["function"]["name"] is None
        assert td["function"]["arguments"] == '{"a":"1"}'

    @patch("simple_agent_poc.adapters.llm.litellm_client.responses")
    def test_complete_stream_preserves_call_id_across_arguments_delta(
        self,
        mock_responses: MagicMock,
    ) -> None:
        item = MagicMock()
        item.type = "function_call"
        item.call_id = "call_001"
        item.name = "concat"
        item.arguments = ""

        added_event = MagicMock()
        added_event.type = "response.output_item.added"
        added_event.output_index = 0
        added_event.item = item

        delta_event = MagicMock()
        delta_event.type = "response.function_call_arguments.delta"
        delta_event.output_index = 0
        delta_event.item_id = "fc_001"
        delta_event.delta = '{"a":"1"}'

        mock_responses.return_value = [added_event, delta_event]

        client = LiteLLMResponsesClient(model="gpt-5.4-nano")
        result = list(client.complete_stream([]))

        assert len(result) == 2
        first_delta = result[0]["tool_call_delta"]
        second_delta = result[1]["tool_call_delta"]
        assert first_delta is not None
        assert second_delta is not None
        assert first_delta["id"] == "call_001"
        assert second_delta["id"] == "call_001"
        assert second_delta["function"]["arguments"] == '{"a":"1"}'

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
