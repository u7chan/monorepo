# CLI Mode

The interactive CLI provides a `stdin`/`stdout` loop for chatting with agents. It supports both synchronous execution and streaming, including interactive tool calls like `ask_user`.

## Entry Point

```bash
uv run dev                 # uses the "default" agent
uv run dev --agent kansaiben
```

Source: `src/simple_agent_poc/entrypoints/main_cli.py`

## Startup Flow

1. `main_cli.py:main()` parses `--agent` argument.
2. `build_cli_adapter(agent_id=...)` wires dependencies:
   - `bootstrap.create_agent_definition_registry()` → loads `agents.yaml`
   - `bootstrap.create_default_tool_executor()` → creates built-in tool registry
   - `bootstrap.create_run_agent_use_case(agent_definitions=..., tool_executor=...)` → creates the use case
3. `CLIAdapter(use_case, agent_id, agent_definitions)` is constructed.
4. `adapter.run()` starts the interactive loop.

## CLIAdapter

Source: `src/simple_agent_poc/adapters/cli/adapter.py`

The adapter uses protocol-based dependency injection for testability. All renderers and readers can be swapped via constructor arguments.

### Constructor Parameters

| Parameter | Type | Default | Description |
|:---|:---|:---|:---|
| `run_agent` | `RunAgentUseCase` | required | Shared agent execution use case |
| `agent_id` | `str` | `"default"` | Active agent ID |
| `agent_definitions` | `AgentDefinitionRegistry` | `None` | For checking `stream` flag |
| `input_reader` | `Callable[[], str]` | `get_user_input` | Reads a line from stdin |
| `response_renderer` | `Callable[[RunAgentResponse], None]` | `show_agent_response` | Displays sync response |
| `streaming_renderer` | `StreamingRenderer` | `show_streaming_response` | Handles live text output |
| `error_renderer` | `Callable[[Exception], None]` | `show_error` | Displays error messages |
| `welcome_renderer` | `WelcomeRenderer` | `show_welcome` | Displays banner |
| `exit_renderer` | `Callable[[], None]` | `show_exit_message` | Exit message |
| `indicator_runner` | `IndicatorRunner` | `with_indicator` | Spinner wrapper |

### Interactive Loop

The loop handles both sync and streaming modes:

```
while True:
    input = get_user_input()
    if blank → continue

    if agent.stream:
        generator = use_case.execute_stream(request)
        for event in generator:
            if event is ContentDelta → show live text
            if event is ToolCallEvent → show tool call; for ask_user, prompt user
                and send answer via generator.send(answer)
            if event is ToolResultEvent → show tool result
            if event is StreamComplete → show stats, capture session_id
    else:
        response = with_indicator("Thinking", lambda: use_case.execute(request))
        while response is RunAgentPaused:
            answer = ask_user_question(response.question)
            response = with_indicator(
                "Thinking",
                lambda: use_case.continue_sync(ContinueRequest(
                    session_id=response.session_id, answer=answer
                ))
            )
        show_agent_response(response)

    self._session_id = response.session_id
```

### Sync `ask_user` Loop (Non-Stream Mode)

When `stream: false` (default), `execute()` returns `RunAgentResponse | RunAgentPaused`. If `RunAgentPaused` is returned:

1. The indicator stops automatically (via `finally` in `with_indicator`).
2. `ask_user_question(question)` displays the question and reads the user's answer from stdin.
3. `continue_sync(ContinueRequest(session_id, answer))` is called with a new indicator.
4. If `continue_sync` returns another `RunAgentPaused` (multiple `ask_user` in same batch), the loop repeats.
5. When `RunAgentResponse` is finally returned, it is rendered via `show_agent_response()`.

The user never needs to know the `session_id` — it is managed internally by the adapter.

### `generator.send()` Pattern (Stream Mode, ask\_user)

When the LLM calls `ask_user` in CLI streaming mode, the `execute_stream()` generator yields a `ToolCallEvent` and **pauses**, waiting for the adapter to send the user's answer back:

1. Generator yields `ToolCallEvent(name="ask_user", arguments={"question": "..."})`.
2. CLI renderer displays the question and prompts for input via `ask_user_question()`.
3. Adapter calls `generator.send(answer)` to inject the answer.
4. Generator yields `ToolResultEvent` with the result.
5. LLM continues generating its response based on the answer.

This pattern works because CLI is a single-process event loop. For HTTP API, the pause/resume pattern is used instead (see [docs/sse.md](sse.md)).

### Exit Conditions

- `KeyboardInterrupt` (Ctrl+C) → calls `show_exit_message()`, breaks loop
- `EOFError` (Ctrl+D) → calls `show_exit_message()`, breaks loop
- Other `Exception` → calls `show_error(error)`, loop continues

## Renderer

Source: `src/simple_agent_poc/adapters/cli/renderer.py`

### LoadingIndicator

Braille spinner animation running in a background thread.

- Spinner chars: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`
- Frame interval: 80ms
- Output: `\r<char> <message>...`
- On stop: clears the line with spaces

### show_welcome(agent_id)

```
════════════════════════════════════════
  ✨  Welcome to Simple Agent POC  ✨
     (Press Ctrl+C to exit)
     AgentId: <agent_id>
════════════════════════════════════════
```

### show_agent_response(response)

```
Agent: <response.message>
  └─ Model: <short_name> │ Time: <X.Xs> │ Tokens: <N> → <M> (total: <T>)
```

- Model name: displays only the part after `/` if present
- Time: `< 1s` shown in ms, else in seconds with 2 decimal places
- Tokens: `prompt_tokens → completion_tokens (total: total_tokens)`
- If `response.tool_call_history` is non-empty, each tool call and its result is displayed

### show_streaming_response(stream)

1. Starts `LoadingIndicator`.
2. On `ContentDelta`: stops indicator, prints `"Agent: "`, writes delta text in-place.
3. On `ToolCallEvent`: displays the tool call being made.
4. **For `ask_user`**: calls `ask_user_question(question)` which displays the question and reads user input, then `generator.send(answer)` to resume the stream.
5. On `ToolResultEvent`: displays the tool result.
6. On `SessionPaused`: displays the pause notification (API mode only; not expected in CLI).
7. On `StreamComplete`: prints newline, then stats line (same format as `show_agent_response`).
8. Returns the `StreamComplete` event.

If no `ContentDelta` was received before `StreamComplete`, the indicator is stopped and `"Agent: "` is printed before the stats.

If no `StreamComplete` arrives at all, raises `RuntimeError`.

### ask_user_question(question)

```python
def ask_user_question(question: str) -> str:
    print(f"\n  💬 ask_user: {question}")
    return input("  Answer > ").strip()
```

Displays the `ask_user` question and reads the user's typed answer from stdin. Used by both sync and stream modes.

### show_error(error)

- `AgentError` subclasses: prints `"⚠️  Error: {error.display_message}"`
- Other exceptions: prints `"⚠️  Error: An unexpected error occurred: {error}"`

### with_indicator(message, operation)

Wraps a synchronous operation with a `LoadingIndicator`:
1. `indicator.start()` (background spinner starts)
2. `operation()` executes
3. `indicator.stop()` in `finally` (spinner stops, line cleared)
