"""Tests for agent module."""

from unittest.mock import MagicMock

import pytest

from simple_agent_poc.agent import Agent
from simple_agent_poc.types import LLMResponse, ValidationError

DEFAULT_SYSTEM_PROMPT = """You are an AI assistant."""
DEFAULT_MODEL = "test-model"


class TestAgent:
    """Tests for Agent class."""

    def test_init_with_default_client(self) -> None:
        """Test agent initialization with default client."""
        agent = Agent(system_prompt=DEFAULT_SYSTEM_PROMPT, model=DEFAULT_MODEL)
        assert agent._client is not None
        assert len(agent._messages) == 1
        assert agent._messages[0]["role"] == "system"

    def test_init_with_custom_client(self) -> None:
        """Test agent initialization with custom client."""
        mock_client = MagicMock()
        agent = Agent(
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            model=DEFAULT_MODEL,
            llm_client=mock_client,
        )
        assert agent._client is mock_client
        assert len(agent._messages) == 1
        assert agent._messages[0]["role"] == "system"

    def test_system_prompt_is_set(self) -> None:
        """Test that system prompt is set correctly."""
        agent = Agent(system_prompt=DEFAULT_SYSTEM_PROMPT, model=DEFAULT_MODEL)
        assert agent._system_prompt == DEFAULT_SYSTEM_PROMPT
        assert "AI assistant" in agent._messages[0]["content"]

    def test_custom_system_prompt(self) -> None:
        """Test that custom system prompt is applied."""
        custom_prompt = "You are a helpful coding assistant."
        agent = Agent(system_prompt=custom_prompt, model=DEFAULT_MODEL)
        assert agent._system_prompt == custom_prompt
        assert "coding assistant" in agent._messages[0]["content"]

    def test_system_prompt_used_as_is(self) -> None:
        """Test that system prompt is used as-is without formatting."""
        # Agent should not modify the system prompt - it should be pre-formatted by caller
        prompt_with_placeholder = "You are an AI. Current time: {current_datetime}"
        agent = Agent(system_prompt=prompt_with_placeholder, model=DEFAULT_MODEL)

        # The placeholder should remain unformatted (caller is responsible for formatting)
        assert "{current_datetime}" in agent._messages[0]["content"]

    def test_init_requires_system_prompt(self) -> None:
        """Test that system_prompt is required."""
        with pytest.raises(ValidationError, match="system_prompt is required"):
            Agent(system_prompt="", model=DEFAULT_MODEL)

    def test_init_requires_model(self) -> None:
        """Test that model is required."""
        with pytest.raises(ValidationError, match="model is required"):
            Agent(system_prompt=DEFAULT_SYSTEM_PROMPT, model="")

    def test_system_message_is_first(self) -> None:
        """Test that system message is at the beginning of messages."""
        mock_client = MagicMock()
        mock_client.complete.return_value = {
            "content": "Response",
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        }

        agent = Agent(
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            model=DEFAULT_MODEL,
            llm_client=mock_client,
        )
        agent.process_user_input("Hello")

        # System message should be first, then user message
        assert agent._messages[0]["role"] == "system"
        assert agent._messages[1]["role"] == "user"
        assert agent._messages[2]["role"] == "assistant"

    def test_init_with_custom_model(self) -> None:
        """Test agent initialization with custom model."""
        from simple_agent_poc.llm_client import LiteLLMClient

        agent = Agent(system_prompt=DEFAULT_SYSTEM_PROMPT, model="gpt-4o")
        assert isinstance(agent._client, LiteLLMClient)
        assert agent._client.model == "gpt-4o"

    def test_process_user_input(self) -> None:
        """Test processing user input."""
        mock_client = MagicMock()
        mock_response: LLMResponse = {
            "content": "Hello, user!",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
        }
        mock_client.complete.return_value = mock_response

        agent = Agent(
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            model=DEFAULT_MODEL,
            llm_client=mock_client,
        )
        response = agent.process_user_input("Hello")

        assert response == mock_response
        # System message + user message + assistant message = 3
        assert len(agent._messages) == 3

        # Check system message is first
        assert agent._messages[0]["role"] == "system"

        # Check user message was added
        assert agent._messages[1] == {"role": "user", "content": "Hello"}

        # Check assistant message was added
        assert agent._messages[2] == {
            "role": "assistant",
            "content": "Hello, user!",
        }

    def test_conversation_history(self) -> None:
        """Test that conversation history is maintained."""
        captured_calls: list = []

        def capture_and_return(*args, **kwargs):
            # Capture a copy of messages at call time
            captured_calls.append(list(args[0]) if args else [])
            return {
                "content": "Response",
                "usage": {
                    "prompt_tokens": 5,
                    "completion_tokens": 3,
                    "total_tokens": 8,
                },
            }

        mock_client = MagicMock()
        mock_client.complete.side_effect = capture_and_return

        agent = Agent(
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            model=DEFAULT_MODEL,
            llm_client=mock_client,
        )

        # First message (system + user + assistant = 3)
        agent.process_user_input("First")
        assert len(agent._messages) == 3

        # Second message (system + user1 + assistant1 + user2 + assistant2 = 5)
        agent.process_user_input("Second")
        assert len(agent._messages) == 5

        # Verify complete was called with accumulated messages
        # Second call should have: system, user1, assistant1, user2 (4 messages)
        # because complete() is called before assistant response is added
        second_call_args = captured_calls[1]
        assert len(second_call_args) == 4
        assert second_call_args[0]["role"] == "system"
        assert second_call_args[1]["role"] == "user"
        assert second_call_args[1]["content"] == "First"
        assert second_call_args[2]["role"] == "assistant"
        assert second_call_args[3]["role"] == "user"
        assert second_call_args[3]["content"] == "Second"

    def test_client_receive_correct_messages(self) -> None:
        """Test that client receives correct message format."""
        captured_calls: list = []

        def capture_and_return(*args, **kwargs):
            # Capture a copy of messages at call time
            captured_calls.append(list(args[0]) if args else [])
            return {
                "content": "Test response",
                "usage": {
                    "prompt_tokens": 2,
                    "completion_tokens": 3,
                    "total_tokens": 5,
                },
            }

        mock_client = MagicMock()
        mock_client.complete.side_effect = capture_and_return

        agent = Agent(
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            model=DEFAULT_MODEL,
            llm_client=mock_client,
        )
        agent.process_user_input("Test")

        # Check the messages passed to complete() at call time
        # Should include system message + user message
        assert len(captured_calls) == 1
        call_args = captured_calls[0]
        assert len(call_args) == 2
        assert call_args[0]["role"] == "system"
        assert call_args[1]["role"] == "user"
        assert call_args[1]["content"] == "Test"
