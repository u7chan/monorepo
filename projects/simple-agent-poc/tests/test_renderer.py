"""Tests for CLI renderer functions."""

from unittest.mock import MagicMock, patch


from simple_agent_poc.adapters.cli.renderer import (
    ask_user_question,
    get_user_input,
    show_error,
    show_exit_message,
    show_welcome,
)
from simple_agent_poc.core.types import AgentError, AuthenticationError


class TestShowError:
    """Tests for show_error function."""

    @patch("builtins.print")
    def test_show_agent_error(self, mock_print: MagicMock) -> None:
        error = AgentError(
            message="Internal details",
            display_message="User-friendly message",
        )
        show_error(error)

        mock_print.assert_called_once_with("⚠️  Error: User-friendly message")

    @patch("builtins.print")
    def test_show_authentication_error(self, mock_print: MagicMock) -> None:
        error = AuthenticationError(
            message="Auth failed",
            display_message="Please check your API key",
        )
        show_error(error)

        mock_print.assert_called_once_with("⚠️  Error: Please check your API key")

    @patch("builtins.print")
    def test_show_generic_exception(self, mock_print: MagicMock) -> None:
        error = ValueError("Something went wrong")
        show_error(error)

        mock_print.assert_called_once_with(
            "⚠️  Error: An unexpected error occurred: Something went wrong"
        )


class TestShowWelcome:
    """Tests for show_welcome function."""

    @patch("builtins.print")
    def test_show_welcome(self, mock_print: MagicMock) -> None:
        show_welcome()

        assert mock_print.call_count == 6
        calls = [
            call.args[0] if call.args else "" for call in mock_print.call_args_list
        ]
        non_empty_calls = [call for call in calls if call]
        assert "═" * 40 in non_empty_calls[0]
        assert "Welcome to Simple Agent POC" in non_empty_calls[1]
        assert "Ctrl+C" in non_empty_calls[2]
        assert "AgentId: default" in non_empty_calls[3]

    @patch("builtins.print")
    def test_show_welcome_with_configured_agent_id(self, mock_print: MagicMock) -> None:
        show_welcome("researcher")

        calls = [
            call.args[0] if call.args else "" for call in mock_print.call_args_list
        ]
        non_empty_calls = [call for call in calls if call]
        assert "AgentId: researcher" in non_empty_calls[3]


class TestGetUserInput:
    """Tests for get_user_input function."""

    @patch("builtins.input", return_value="hello world")
    def test_get_user_input(self, mock_input: MagicMock) -> None:
        result = get_user_input()

        assert result == "hello world"
        mock_input.assert_called_once_with("> ")

    @patch("builtins.input", return_value="")
    def test_get_empty_input(self, mock_input: MagicMock) -> None:
        result = get_user_input()

        assert result == ""


class TestShowExitMessage:
    """Tests for show_exit_message function."""

    @patch("builtins.print")
    def test_show_exit_message(self, mock_print: MagicMock) -> None:
        show_exit_message()

        mock_print.assert_called_once_with("\nExiting...")


class TestAskUserQuestion:
    """Tests for ask_user_question rendering."""

    @patch("builtins.input", return_value="Alice")
    @patch("builtins.print")
    def test_text_type_prompt(
        self, mock_print: MagicMock, mock_input: MagicMock
    ) -> None:
        questions = [
            {
                "question": "What is your name?",
                "header": "Name",
                "type": "text",
                "placeholder": "e.g. Alice",
            }
        ]
        result = ask_user_question(questions)

        assert result == {"What is your name?": "Alice"}
        mock_input.assert_called_once_with(
            "  [Name] What is your name? (e.g. Alice) > "
        )

    @patch("builtins.input", return_value="1")
    @patch("builtins.print")
    def test_choice_single_select(
        self, mock_print: MagicMock, mock_input: MagicMock
    ) -> None:
        questions = [
            {
                "question": "Which database?",
                "header": "DB",
                "type": "choice",
                "options": [
                    {"label": "PostgreSQL", "description": "OSS RDBMS"},
                    {"label": "SQLite"},
                ],
                "multiSelect": False,
            }
        ]
        result = ask_user_question(questions)

        assert result == {"Which database?": "1"}
        calls = [
            call.args[0] if call.args else "" for call in mock_print.call_args_list
        ]
        assert "  [DB] Which database?" in calls
        assert "    1. PostgreSQL — OSS RDBMS" in calls
        assert "    2. SQLite" in calls
        mock_input.assert_called_once_with("  選択（番号または自由記述）> ")

    @patch("builtins.input", return_value="1, 2")
    @patch("builtins.print")
    def test_choice_multi_select(
        self, mock_print: MagicMock, mock_input: MagicMock
    ) -> None:
        questions = [
            {
                "question": "Pick sections",
                "type": "choice",
                "options": [
                    {"label": "Intro", "description": "Introduction"},
                    {"label": "Conclusion"},
                ],
                "multiSelect": True,
            }
        ]
        result = ask_user_question(questions)

        assert result == {"Pick sections": "1, 2"}
        calls = [
            call.args[0] if call.args else "" for call in mock_print.call_args_list
        ]
        assert "  Pick sections" in calls
        assert "    1. Intro — Introduction" in calls
        mock_input.assert_called_once_with("  選択（カンマ区切りで複数可）> ")

    @patch("builtins.input", side_effect=["my-app", "1", "TypeScript"])
    @patch("builtins.print")
    def test_multi_question_batch(
        self, mock_print: MagicMock, mock_input: MagicMock
    ) -> None:
        questions = [
            {
                "question": "プロジェクト名は？",
                "header": "Project",
                "type": "text",
            },
            {
                "question": "どのDBを使う？",
                "header": "DB",
                "type": "choice",
                "options": [
                    {"label": "PostgreSQL", "description": "OSS RDBMS"},
                    {"label": "SQLite"},
                ],
                "multiSelect": False,
            },
        ]
        result = ask_user_question(questions)

        assert result == {
            "プロジェクト名は？": "my-app",
            "どのDBを使う？": "1",
        }
        assert mock_input.call_count == 2
        input_calls = [call.args[0] for call in mock_input.call_args_list]
        calls = [
            call.args[0] if call.args else "" for call in mock_print.call_args_list
        ]
        # text question: prefix in input prompt
        # choice question: prefix in print line
        assert any("(1/2)" in c for c in input_calls + calls)
        assert any("(2/2)" in c for c in input_calls + calls)
