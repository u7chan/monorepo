# CLI Mode

The interactive CLI provides a `stdin`/`stdout` loop for chatting with agents.

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
   - `bootstrap.create_run_agent_use_case(agent_definitions=...)` → creates the use case
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

```
while True:
    input = get_user_input()
    if blank → continue

    if agent.stream:
        complete = show_streaming_response(use_case.execute_stream(request))
    else:
        response = with_indicator("Thinking", lambda: use_case.execute(request))
        show_agent_response(response)

    self._session_id = response.session_id  # track for next iteration
```

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

### show_streaming_response(stream)

1. Starts `LoadingIndicator`.
2. On first `ContentDelta`: stops indicator, prints `"Agent: "`, writes delta text in-place.
3. Subsequent `ContentDelta`: writes delta text without prefix.
4. On `StreamComplete`: prints newline, then stats line (same format as `show_agent_response`).
5. Returns the `StreamComplete` event.

If no `ContentDelta` was received before `StreamComplete`, the indicator is stopped and `"Agent: "` is printed before the stats.

If no `StreamComplete` arrives at all, raises `RuntimeError`.

### show_error(error)

- `AgentError` subclasses: prints `"⚠️  Error: {error.display_message}"`
- Other exceptions: prints `"⚠️  Error: An unexpected error occurred: {error}"`

### with_indicator(message, operation)

Wraps a synchronous operation with a `LoadingIndicator`:
1. `indicator.start()` (background spinner starts)
2. `operation()` executes
3. `indicator.stop()` in `finally` (spinner stops, line cleared)
