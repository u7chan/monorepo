"""Tests for agent module."""

from unittest.mock import MagicMock

from simple_agent_poc.agent import Agent
from simple_agent_poc.types import LLMResponse


class TestAgent:
    """Tests for Agent class."""

    def test_init_with_default_client(self) -> None:
        """Test agent initialization with default client."""
        agent = Agent()
        assert agent._client is not None
        assert agent._messages == []

    def test_init_with_custom_client(self) -> None:
        """Test agent initialization with custom client."""
        mock_client = MagicMock()
        agent = Agent(llm_client=mock_client)
        assert agent._client is mock_client
        assert agent._messages == []

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

        agent = Agent(llm_client=mock_client)
        response = agent.process_user_input("Hello")

        assert response == mock_response
        assert len(agent._messages) == 2

        # Check user message was added
        assert agent._messages[0] == {"role": "user", "content": "Hello"}

        # Check assistant message was added
        assert agent._messages[1] == {
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

        agent = Agent(llm_client=mock_client)

        # First message
        agent.process_user_input("First")
        assert len(agent._messages) == 2

        # Second message
        agent.process_user_input("Second")
        assert len(agent._messages) == 4

        # Verify complete was called with accumulated messages
        # Second call should have: user1, assistant1, user2 (3 messages)
        # because complete() is called before assistant response is added
        second_call_args = captured_calls[1]
        assert len(second_call_args) == 3
        assert second_call_args[0]["role"] == "user"
        assert second_call_args[0]["content"] == "First"
        assert second_call_args[1]["role"] == "assistant"
        assert second_call_args[2]["role"] == "user"
        assert second_call_args[2]["content"] == "Second"

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

        agent = Agent(llm_client=mock_client)
        agent.process_user_input("Test")

        # Check the messages passed to complete() at call time
        assert len(captured_calls) == 1
        call_args = captured_calls[0]
        assert len(call_args) == 1
        assert call_args[0]["role"] == "user"
        assert call_args[0]["content"] == "Test"
