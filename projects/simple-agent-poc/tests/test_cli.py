"""Tests for the CLI adapter."""

from collections.abc import Callable
from unittest.mock import MagicMock

import pytest

from simple_agent_poc.application import RunAgentResponse
from simple_agent_poc.cli import CLIAdapter


def passthrough_indicator(
    message: str,
    operation: Callable[[], RunAgentResponse],
) -> RunAgentResponse:
    """Run the operation immediately for deterministic tests."""
    assert message == "Thinking"
    return operation()


class TestCLIAdapter:
    """Tests for the CLI adapter."""

    def test_run_delegates_to_use_case_and_renders_response(self) -> None:
        run_agent = MagicMock()
        run_agent.execute.return_value = RunAgentResponse(
            message="Hello, user!",
            usage={
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
            model="gpt-4o-mini",
            response_time=0.85,
        )
        input_reader = MagicMock(side_effect=["Hello", EOFError()])
        response_renderer = MagicMock()
        welcome_renderer = MagicMock()
        exit_renderer = MagicMock()

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            response_renderer=response_renderer,
            welcome_renderer=welcome_renderer,
            exit_renderer=exit_renderer,
            indicator_runner=passthrough_indicator,
        )

        adapter.run()

        welcome_renderer.assert_called_once_with()
        run_agent.execute.assert_called_once()
        request = run_agent.execute.call_args.args[0]
        assert request.message == "Hello"
        response_renderer.assert_called_once_with(run_agent.execute.return_value)
        exit_renderer.assert_called_once_with()

    def test_run_skips_blank_input(self) -> None:
        run_agent = MagicMock()
        input_reader = MagicMock(side_effect=["   ", "\t", EOFError()])

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            indicator_runner=passthrough_indicator,
        )

        adapter.run()

        run_agent.execute.assert_not_called()

    @pytest.mark.parametrize("interrupt", [KeyboardInterrupt(), EOFError()])
    def test_run_exits_cleanly_on_terminal_interrupts(
        self,
        interrupt: BaseException,
    ) -> None:
        exit_renderer = MagicMock()
        run_agent = MagicMock()
        input_reader = MagicMock(side_effect=[interrupt])

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            exit_renderer=exit_renderer,
            indicator_runner=passthrough_indicator,
        )

        adapter.run()

        run_agent.execute.assert_not_called()
        exit_renderer.assert_called_once_with()

    def test_run_shows_errors_and_continues(self) -> None:
        run_agent = MagicMock()
        recovered_response = RunAgentResponse(
            message="Recovered",
            usage={
                "prompt_tokens": 2,
                "completion_tokens": 1,
                "total_tokens": 3,
            },
            model="gpt-4o-mini",
            response_time=0.25,
        )
        run_agent.execute.side_effect = [RuntimeError("boom"), recovered_response]
        input_reader = MagicMock(side_effect=["Hello", "Retry", EOFError()])
        error_renderer = MagicMock()
        response_renderer = MagicMock()

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            error_renderer=error_renderer,
            response_renderer=response_renderer,
            indicator_runner=passthrough_indicator,
        )

        adapter.run()

        error_renderer.assert_called_once()
        assert isinstance(error_renderer.call_args.args[0], RuntimeError)
        assert run_agent.execute.call_count == 2
        response_renderer.assert_called_once_with(recovered_response)
