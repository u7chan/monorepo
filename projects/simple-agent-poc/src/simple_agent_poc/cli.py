"""CLI adapter for the application flow."""

from collections.abc import Callable
from typing import Protocol

from simple_agent_poc.application import (
    RunAgentRequest,
    RunAgentResponse,
    RunAgentUseCase,
)
from simple_agent_poc.renderer import (
    get_user_input,
    show_agent_response,
    show_error,
    show_exit_message,
    show_welcome,
    with_indicator,
)


class IndicatorRunner(Protocol):
    """Wrap an operation with CLI-only progress feedback."""

    def __call__(
        self,
        message: str,
        operation: Callable[[], RunAgentResponse],
    ) -> RunAgentResponse: ...


class CLIAdapter:
    """Thin stdin/stdout adapter around the shared agent use case."""

    def __init__(
        self,
        run_agent: RunAgentUseCase,
        *,
        input_reader: Callable[[], str] = get_user_input,
        response_renderer: Callable[[RunAgentResponse], None] = show_agent_response,
        error_renderer: Callable[[Exception], None] = show_error,
        welcome_renderer: Callable[[], None] = show_welcome,
        exit_renderer: Callable[[], None] = show_exit_message,
        indicator_runner: IndicatorRunner = with_indicator,
    ) -> None:
        self._run_agent = run_agent
        self._input_reader = input_reader
        self._response_renderer = response_renderer
        self._error_renderer = error_renderer
        self._welcome_renderer = welcome_renderer
        self._exit_renderer = exit_renderer
        self._indicator_runner = indicator_runner

    def run(self) -> None:
        """Start the interactive CLI loop."""
        self._welcome_renderer()

        while True:
            try:
                user_input = self._input_reader()
                if not user_input.strip():
                    continue

                response = self._indicator_runner(
                    "Thinking",
                    lambda: self._run_agent.execute(
                        RunAgentRequest(message=user_input)
                    ),
                )
                self._response_renderer(response)
            except KeyboardInterrupt:
                self._exit_renderer()
                break
            except EOFError:
                self._exit_renderer()
                break
            except Exception as error:
                self._error_renderer(error)
