"""CLI adapter for the application flow."""

from collections.abc import Callable, Generator
from typing import Protocol

from simple_agent_poc.application.dto import (
    ContentDelta,
    RunAgentRequest,
    RunAgentResponse,
    SessionPaused,
    StreamComplete,
    ToolCallEvent,
    ToolResultEvent,
)
from simple_agent_poc.application.use_cases import RunAgentUseCase
from simple_agent_poc.adapters.cli.renderer import (
    get_user_input,
    show_agent_response,
    show_error,
    show_exit_message,
    show_streaming_response,
    show_welcome,
    with_indicator,
)
from simple_agent_poc.core.agent_definition import AgentDefinitionRegistry


class IndicatorRunner(Protocol):
    """Wrap an operation with CLI-only progress feedback."""

    def __call__(
        self,
        message: str,
        operation: Callable[[], RunAgentResponse],
    ) -> RunAgentResponse: ...


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
            str | None,
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
        agent_definitions: AgentDefinitionRegistry | None = None,
        input_reader: Callable[[], str] = get_user_input,
        response_renderer: Callable[[RunAgentResponse], None] = show_agent_response,
        streaming_renderer: StreamingRenderer = show_streaming_response,
        error_renderer: Callable[[Exception], None] = show_error,
        welcome_renderer: WelcomeRenderer = show_welcome,
        exit_renderer: Callable[[], None] = show_exit_message,
        indicator_runner: IndicatorRunner = with_indicator,
    ) -> None:
        self._run_agent = run_agent
        self._agent_id = agent_id
        self._agent_definitions = agent_definitions
        self._input_reader = input_reader
        self._response_renderer = response_renderer
        self._streaming_renderer = streaming_renderer
        self._error_renderer = error_renderer
        self._welcome_renderer = welcome_renderer
        self._exit_renderer = exit_renderer
        self._indicator_runner = indicator_runner
        self._session_id: str | None = None

    def run(self) -> None:
        """Start the interactive CLI loop."""
        self._welcome_renderer(self._agent_id)
        agent_def = (
            self._agent_definitions.get(self._agent_id)
            if self._agent_definitions
            else None
        )

        while True:
            try:
                user_input = self._input_reader()
                if not user_input.strip():
                    continue

                if agent_def and agent_def.stream:
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
                else:
                    response = self._indicator_runner(
                        "Thinking",
                        lambda: self._run_agent.execute(
                            RunAgentRequest(
                                message=user_input,
                                session_id=self._session_id,
                                agent_id=self._agent_id,
                            )
                        ),
                    )
                    self._session_id = response.session_id
                    self._response_renderer(response)
            except KeyboardInterrupt:
                self._exit_renderer()
                break
            except EOFError:
                self._exit_renderer()
                break
            except Exception as error:
                self._error_renderer(error)
