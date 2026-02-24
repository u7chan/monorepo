"""Tests for renderer module."""

from unittest.mock import MagicMock, patch

import pytest

from simple_agent_poc.renderer import (
    get_user_input,
    show_agent_response,
    show_error,
    show_exit_message,
    show_welcome,
    with_indicator,
)
from simple_agent_poc.types import AgentError, AuthenticationError, LLMResponse


class TestShowError:
    """Tests for show_error function."""

    @patch("builtins.print")
    def test_show_agent_error(self, mock_print: MagicMock) -> None:
        """Test showing an AgentError."""
        error = AgentError(
            message="Internal details",
            display_message="User-friendly message",
        )
        show_error(error)

        mock_print.assert_called_once_with("⚠️  Error: User-friendly message")

    @patch("builtins.print")
    def test_show_authentication_error(self, mock_print: MagicMock) -> None:
        """Test showing an AuthenticationError."""
        error = AuthenticationError(
            message="Auth failed",
            display_message="Please check your API key",
        )
        show_error(error)

        mock_print.assert_called_once_with("⚠️  Error: Please check your API key")

    @patch("builtins.print")
    def test_show_generic_exception(self, mock_print: MagicMock) -> None:
        """Test showing a generic exception."""
        error = ValueError("Something went wrong")
        show_error(error)

        mock_print.assert_called_once_with(
            "⚠️  Error: An unexpected error occurred: Something went wrong"
        )


class TestShowWelcome:
    """Tests for show_welcome function."""

    @patch("builtins.print")
    def test_show_welcome(self, mock_print: MagicMock) -> None:
        """Test showing welcome banner."""
        show_welcome()

        assert mock_print.call_count == 5
        calls = [
            call.args[0] if call.args else "" for call in mock_print.call_args_list
        ]
        # Filter out empty prints (just newlines)
        non_empty_calls = [c for c in calls if c]
        assert "═" * 40 in non_empty_calls[0]
        assert "Welcome to Simple Agent POC" in non_empty_calls[1]
        assert "Ctrl+C" in non_empty_calls[2]


class TestGetUserInput:
    """Tests for get_user_input function."""

    @patch("builtins.input", return_value="hello world")
    def test_get_user_input(self, mock_input: MagicMock) -> None:
        """Test getting user input."""
        result = get_user_input()

        assert result == "hello world"
        mock_input.assert_called_once_with("> ")

    @patch("builtins.input", return_value="")
    def test_get_empty_input(self, mock_input: MagicMock) -> None:
        """Test getting empty input."""
        result = get_user_input()

        assert result == ""


class TestShowAgentResponse:
    """Tests for show_agent_response function."""

    @patch("builtins.print")
    def test_show_response(self, mock_print: MagicMock) -> None:
        """Test showing agent response."""
        response: LLMResponse = {
            "content": "Hello, user!",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            "model": "gpt-4o-mini",
            "response_time": 0.85,
        }
        show_agent_response(response)

        assert mock_print.call_count == 2
        calls = [call.args[0] for call in mock_print.call_args_list]
        assert calls[0] == "Agent: Hello, user!"
        assert "gpt-4o-mini" in calls[1]
        assert "850ms" in calls[1] or "0.85s" in calls[1]
        assert "10 → 5" in calls[1]
        assert "total: 15" in calls[1]


class TestShowExitMessage:
    """Tests for show_exit_message function."""

    @patch("builtins.print")
    def test_show_exit_message(self, mock_print: MagicMock) -> None:
        """Test showing exit message."""
        show_exit_message()

        mock_print.assert_called_once_with("\nExiting...")


class TestWithIndicator:
    """Tests for with_indicator function."""

    def test_executes_operation_and_returns_result(self) -> None:
        """Test that operation is executed and result is returned."""
        mock_op = MagicMock(return_value="test_result")

        result = with_indicator("Loading", mock_op)

        assert result == "test_result"
        mock_op.assert_called_once()

    def test_propagates_exception_and_stops_indicator(self) -> None:
        """Test that exceptions are propagated and indicator stops cleanly."""
        mock_op = MagicMock(side_effect=ValueError("test error"))

        with pytest.raises(ValueError, match="test error"):
            with_indicator("Loading", mock_op)

        mock_op.assert_called_once()
