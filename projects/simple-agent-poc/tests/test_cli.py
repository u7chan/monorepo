"""Tests for the CLI adapter."""

from unittest.mock import MagicMock

import pytest

from simple_agent_poc.adapters.cli.adapter import CLIAdapter
from simple_agent_poc.application.dto import StreamComplete


def _stream_complete(session_id: str = "session-1") -> StreamComplete:
    return StreamComplete(
        session_id=session_id,
        usage={
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
        },
        model="gpt-4o-mini",
        response_time=0.85,
    )


class TestCLIAdapter:
    """Tests for the CLI adapter."""

    def test_run_delegates_to_use_case_and_renders_response(self) -> None:
        run_agent = MagicMock()
        run_agent.execute_stream.return_value = iter([])
        streaming_renderer = MagicMock(return_value=_stream_complete())
        input_reader = MagicMock(side_effect=["Hello", EOFError()])
        welcome_renderer = MagicMock()
        exit_renderer = MagicMock()

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            streaming_renderer=streaming_renderer,
            welcome_renderer=welcome_renderer,
            exit_renderer=exit_renderer,
        )

        adapter.run()

        welcome_renderer.assert_called_once_with("default")
        run_agent.execute_stream.assert_called_once()
        request = run_agent.execute_stream.call_args.args[0]
        assert request.message == "Hello"
        assert request.session_id is None
        assert request.agent_id == "default"
        streaming_renderer.assert_called_once()
        exit_renderer.assert_called_once_with()

    def test_run_passes_configured_agent_id(self) -> None:
        run_agent = MagicMock()
        run_agent.execute_stream.return_value = iter([])
        streaming_renderer = MagicMock(return_value=_stream_complete())
        input_reader = MagicMock(side_effect=["Hello", EOFError()])

        adapter = CLIAdapter(
            run_agent,
            agent_id="researcher",
            input_reader=input_reader,
            streaming_renderer=streaming_renderer,
        )

        adapter.run()

        request = run_agent.execute_stream.call_args.args[0]
        assert request.agent_id == "researcher"

    def test_run_passes_agent_id_to_welcome_renderer(self) -> None:
        run_agent = MagicMock()
        run_agent.execute_stream.return_value = iter([])
        streaming_renderer = MagicMock(return_value=_stream_complete())
        input_reader = MagicMock(side_effect=["Hello", EOFError()])
        welcome_renderer = MagicMock()

        adapter = CLIAdapter(
            run_agent,
            agent_id="researcher",
            input_reader=input_reader,
            streaming_renderer=streaming_renderer,
            welcome_renderer=welcome_renderer,
        )

        adapter.run()

        welcome_renderer.assert_called_once_with("researcher")

    def test_run_reuses_session_id_on_later_turns(self) -> None:
        run_agent = MagicMock()
        run_agent.execute_stream.return_value = iter([])
        streaming_renderer = MagicMock(
            side_effect=[
                _stream_complete("session-1"),
                _stream_complete("session-1"),
            ]
        )
        input_reader = MagicMock(side_effect=["Hello", "Again", EOFError()])

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            streaming_renderer=streaming_renderer,
        )

        adapter.run()

        first_request = run_agent.execute_stream.call_args_list[0].args[0]
        second_request = run_agent.execute_stream.call_args_list[1].args[0]
        assert first_request.session_id is None
        assert second_request.session_id == "session-1"

    def test_run_skips_blank_input(self) -> None:
        run_agent = MagicMock()
        input_reader = MagicMock(side_effect=["   ", "\t", EOFError()])

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
        )

        adapter.run()

        run_agent.execute_stream.assert_not_called()

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
        )

        adapter.run()

        run_agent.execute_stream.assert_not_called()
        exit_renderer.assert_called_once_with()

    def test_run_shows_errors_and_continues(self) -> None:
        run_agent = MagicMock()
        run_agent.execute_stream.side_effect = [
            RuntimeError("boom"),
            iter([]),
        ]
        recovered = _stream_complete("session-1")
        streaming_renderer = MagicMock(side_effect=[recovered])

        input_reader = MagicMock(side_effect=["Hello", "Retry", EOFError()])
        error_renderer = MagicMock()

        adapter = CLIAdapter(
            run_agent,
            input_reader=input_reader,
            error_renderer=error_renderer,
            streaming_renderer=streaming_renderer,
        )

        adapter.run()

        error_renderer.assert_called_once()
        assert isinstance(error_renderer.call_args.args[0], RuntimeError)
        assert run_agent.execute_stream.call_count == 2
        assert streaming_renderer.call_count == 1
