"""CLI adapter for the application flow."""

from collections.abc import Callable, Generator
from typing import Protocol

from simple_agent_poc.application.dto import (
    ContentDelta,
    RunAgentRequest,
    SessionPaused,
    StreamComplete,
    ToolCallEvent,
    ToolResultEvent,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.adapters.cli.renderer import (
    get_user_input,
    show_error,
    show_exit_message,
    show_streaming_response,
    show_welcome,
)
from simple_agent_poc.observability import log_event, summarize_payload


class StreamingRenderer(Protocol):
    """Render a streaming response."""

    def __call__(
        self,
        stream: Generator[
            ContentDelta
            | ToolCallEvent
            | ToolResultEvent
            | SessionPaused
            | StreamComplete,
            dict[str, str] | None,
            None,
        ],
    ) -> StreamComplete: ...


class WelcomeRenderer(Protocol):
    """Render the CLI welcome banner."""

    def __call__(self, agent_id: str = "default") -> None: ...


class CLIAdapter:
    """Thin stdin/stdout adapter around the shared agent use case."""

    def __init__(
        self,
        run_agent: RunAgentUseCase,
        *,
        agent_id: str = "default",
        input_reader: Callable[[], str] = get_user_input,
        streaming_renderer: StreamingRenderer = show_streaming_response,
        error_renderer: Callable[[Exception], None] = show_error,
        welcome_renderer: WelcomeRenderer = show_welcome,
        exit_renderer: Callable[[], None] = show_exit_message,
    ) -> None:
        self._run_agent = run_agent
        self._agent_id = agent_id
        self._input_reader = input_reader
        self._streaming_renderer = streaming_renderer
        self._error_renderer = error_renderer
        self._welcome_renderer = welcome_renderer
        self._exit_renderer = exit_renderer
        self._session_id: str | None = None

    def run(self) -> None:
        """Start the interactive CLI loop."""
        self._welcome_renderer(self._agent_id)

        while True:
            try:
                user_input = self._input_reader()
                if not user_input.strip():
                    continue

                complete = self._streaming_renderer(
                    self._run_agent.execute_stream(
                        RunAgentRequest(
                            message=user_input,
                            session_id=self._session_id,
                            agent_id=self._agent_id,
                        )
                    )
                )
                self._session_id = complete.session_id
            except KeyboardInterrupt:
                self._exit_renderer()
                break
            except EOFError:
                self._exit_renderer()
                break
            except Exception as error:
                log_event("cli.turn.error", error=summarize_payload(str(error)))
                self._error_renderer(error)
