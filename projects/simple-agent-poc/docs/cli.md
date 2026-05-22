# CLI Mode

The interactive CLI provides a `stdin`/`stdout` loop for chatting with agents. Execution is streaming-only and supports interactive tool calls like `ask_user`.

## Entry Point

```bash
uv run dev                 # uses the "default" agent
uv run dev --agent kansaiben
```

Source: `src/simple_agent_poc/entrypoints/main_cli.py`

## Startup Flow

1. `main_cli.py:main()` parses `--agent` argument.
2. `build_cli_adapter(agent_id=...)` wires dependencies:
   - `bootstrap.create_agent_definition_registry()` loads `agents.yaml`
   - `bootstrap.create_default_tool_executor()` creates the built-in tool registry
   - `bootstrap.create_run_agent_use_case(agent_definitions=..., tool_executor=...)` creates the use case
3. `CLIAdapter(use_case, agent_id)` is constructed.
4. `adapter.run()` starts the interactive loop.

## CLIAdapter

Source: `src/simple_agent_poc/adapters/cli/adapter.py`

The adapter uses protocol-based dependency injection for testability. Renderers and readers can be swapped via constructor arguments.

### Constructor Parameters

| Parameter | Type | Default | Description |
|:---|:---|:---|:---|
| `run_agent` | `RunAgentUseCase` | required | Shared agent execution use case |
| `agent_id` | `str` | `"default"` | Active agent ID |
| `input_reader` | `Callable[[], str]` | `get_user_input` | Reads a line from stdin |
| `streaming_renderer` | `StreamingRenderer` | `show_streaming_response` | Handles live text output |
| `error_renderer` | `Callable[[Exception], None]` | `show_error` | Displays error messages |
| `welcome_renderer` | `WelcomeRenderer` | `show_welcome` | Displays banner |
| `exit_renderer` | `Callable[[], None]` | `show_exit_message` | Exit message |

### Interactive Loop

The loop always uses `execute_stream()`:

```text
while True:
    input = get_user_input()
    if blank -> continue

    complete = show_streaming_response(
        use_case.execute_stream(RunAgentRequest(
            message=input,
            session_id=self._session_id,
            agent_id=self._agent_id,
        ))
    )
    self._session_id = complete.session_id
```

### `generator.send()` Pattern (ask_user)

When the LLM calls `ask_user` in CLI mode, the `execute_stream()` generator yields a `ToolCallEvent` and pauses, waiting for the adapter to send the user's answers back:

1. Generator yields `ToolCallEvent(name="ask_user", arguments=...)`.
2. CLI renderer displays the questions and prompts for input via `ask_user_question()`.
3. Adapter calls `generator.send(answers)` to inject the answers dict.
4. Generator yields `ToolResultEvent` with the result.
5. LLM continues generating its response based on the answers.

This pattern works because CLI is a single-process event loop. For HTTP API, the pause/resume pattern is used instead (see [docs/sse.md](sse.md)).

### Exit Conditions

- `KeyboardInterrupt` (Ctrl+C): calls `show_exit_message()`, breaks loop
- `EOFError` (Ctrl+D): calls `show_exit_message()`, breaks loop
- Other `Exception`: calls `show_error(error)`, loop continues

## Renderer

Source: `src/simple_agent_poc/adapters/cli/renderer.py`

### LoadingIndicator

Braille spinner animation running in a background thread.

- Frame interval: 80ms
- Output: `\r<char> <message>...`
- On stop: clears the line with spaces

### show_welcome(agent_id)

Displays the welcome banner and selected agent ID.

### show_streaming_response(stream)

1. Starts `LoadingIndicator`.
2. On `ContentDelta`: stops indicator, prints `"Agent: "`, writes delta text in-place.
3. On `ToolCallEvent`: displays the tool call being made.
4. For `ask_user`: calls `ask_user_question(questions)` and sends the answers back with `generator.send(answers)`.
5. On `ToolResultEvent`: displays the tool result.
6. On `SessionPaused`: displays a pause notification. This is API-mode behavior and is not expected in normal CLI execution.
7. On `StreamComplete`: prints a stats line with model, time, and tokens when usage is available.
8. Returns the `StreamComplete` event.

If no `ContentDelta` was received before `StreamComplete`, the indicator is stopped and `"Agent: "` is printed before the stats. If no `StreamComplete` arrives, raises `RuntimeError`.

### ask_user_question(questions)

Displays all `ask_user` questions and reads the user's typed answers from stdin. Returns a `dict[str, str]` mapping question text to answers.

Question items may include:

| Field | Description |
|:---|:---|
| `question` | Question text, also used as the answer key |
| `header` | Optional label displayed before the question |
| `type` | `"text"` or `"choice"` |
| `placeholder` | Optional hint for text input |
| `options` | Choice entries with `label` and optional `description` |
| `multiSelect` | When `true`, comma-separated choice numbers are accepted |

### show_error(error)

- `AgentError` subclasses: prints the domain `display_message`
- Other exceptions: prints an unexpected error message

### with_indicator(message, operation)

Utility for running an operation with `LoadingIndicator`. It remains available in the renderer module but is not used by the streaming-only CLI loop.
