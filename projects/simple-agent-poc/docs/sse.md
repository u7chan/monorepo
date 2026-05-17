# SSE Streaming

Server-Sent Events (SSE) provide real-time streaming of agent responses via the `/api/chat/stream` and `/api/chat/continue` endpoints. The `/api/chat/stream` endpoint uses `RunAgentUseCase.execute_stream()` and the `/api/chat/continue` endpoint uses `RunAgentUseCase.continue_stream()`. Both CLI and HTTP share the same underlying generators — only the SSE formatting differs.

## SSE Format

Media type: `text/event-stream`

Each event is a pair of lines:
```
event: <event_type>
data: <json_payload>
```

Events are separated by an empty line (`\n\n`).

## Event Types

### `delta` — Partial Text

```text
event: delta
data: {"content": "Hello"}
```

Emitted for each chunk of text received from the LLM. The `content` field contains the incremental text.

### `tool_call` — Tool Call Initiated

```text
event: tool_call
data: {"call_id": "call_abc123", "name": "concat", "arguments": "{\"a\":\"Hello\",\"b\":\"World\"}"}
```

Emitted when the LLM requests a tool call. Contains:

| Field | Type | Description |
|:---|:---|:---|
| `call_id` | `str` | Unique ID for this tool call |
| `name` | `str` | Tool name (e.g. `"concat"`, `"get_current_time"`, `"ask_user"`) |
| `arguments` | `str` | JSON-encoded arguments for the tool |

### `tool_result` — Tool Execution Completed

```text
event: tool_result
data: {"call_id": "call_abc123", "name": "concat", "result": "HelloWorld"}
```

Emitted after a tool executes. Contains:

| Field | Type | Description |
|:---|:---|:---|
| `call_id` | `str` | Matches the `tool_call` event's `call_id` |
| `name` | `str` | Tool name |
| `result` | `str` | The tool's output (JSON string for structured results) |

### `paused` — Session Paused (ask\_user)

```text
event: paused
data: {"session_id": "abc123...", "call_id": "call_def456", "question": "What is your preference?"}
```

Emitted when `ask_user` is called in API mode. The SSE stream disconnects after this event. The client must send the answer via `POST /api/chat/continue` to resume. Contains:

| Field | Type | Description |
|:---|:---|:---|
| `session_id` | `str` | Session ID to use for the continue request |
| `call_id` | `str` | Tool call ID (for reference) |
| `question` | `str` | The question to display to the user |

### `complete` — Stream Finished

```text
event: complete
data: {"session_id": "abc123...", "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70}, "model": "gpt-4.1-nano", "response_time": 1.5}
```

Emitted when the stream finishes successfully. Contains:

| Field | Type | Description |
|:---|:---|:---|
| `session_id` | `str` | Session ID for continuing the conversation |
| `usage` | `Usage \| null` | Token usage. May be `null` if the LLM did not provide it. |
| `model` | `str` | Model name |
| `response_time` | `float` | Seconds from stream start to completion |

### `done` — End of Stream

```text
event: done
data: {}
```

Emitted after `complete` or `paused` to signal the end of the SSE stream. Contains an empty JSON object.

### `error` — Error

```text
event: error
data: {"detail": "Session not found."}
```

Emitted when an error occurs during streaming. Contains:

| Field | Type | Description |
|:---|:---|:---|
| `detail` | `str` | Human-readable error message |

## HTTP to SSE Mapping

In `adapters/http/api.py`, the `chat_stream` and `chat_continue` endpoints wrap `execute_stream()` / `continue_stream()` in a `StreamingResponse` generator. See the source code for the exact mapping of each event type.

Errors caught:
- `SessionNotFoundError` → `event: error` with 404 detail
- `ValidationError` → `event: error` with 400 detail
- `SessionNotPausedError` → `event: error`
- Generic `Exception` → `event: error` with the error string

## execute\_stream() Generator Behavior

Source: `src/simple_agent_poc/application/use_cases.py`

1. Validates the message.
2. Loads or creates a session (same as `execute()`).
3. Validates `agent_id` immutability.
4. Appends the user message to the session.
5. Opens the LLM stream via `llm_client.complete_stream(messages, tools=...)`.
6. For each chunk:
   - If `content_delta` is present → accumulates text, yields `ContentDelta(delta=...)`.
   - If `tool_call_delta` is present → accumulates into a pending `ToolCall`.
7. After the stream ends:
   - If tool calls were accumulated → executes each tool, yields `ToolCallEvent` / `ToolResultEvent`.
   - If a tool call is `ask_user` in API mode → yields `SessionPaused`, saves session, and returns (SSE disconnects).
   - If a tool call is `ask_user` in CLI mode → yields `ToolCallEvent` and waits for `generator.send(answer)`.
   - If no tool calls → appends accumulated text as assistant message.
   - Loops up to `MAX_TOOL_ROUNDS = 5` for multi-round tool calls.
8. Yields `StreamComplete(...)` with session metadata.
9. In `finally`: saves the session to the session store.

### Error Handling During Streaming

If the stream raises an exception:

- **Text was accumulated**: Appends `"{accumulated_text}\n\n[stream interrupted]"` to the session.
- **No text was accumulated**: Appends `"[stream interrupted]"` to the session.
- The exception is re-raised after saving.

The `finally` block ensures the session is always persisted, even on failure.

## continue\_stream() — Resuming Paused Sessions

Source: `src/simple_agent_poc/application/use_cases.py`

1. Loads the session by `session_id`. Returns error if not found or not paused.
2. Injects the user's answer as a tool result message.
3. Yields `ToolResultEvent` for the `ask_user` call.
4. Resumes the ReAct loop with the remaining rounds.
5. Yields `StreamComplete` on finish.

## CLI Streaming

In CLI mode, `show_streaming_response()` consumes the same `execute_stream()` generator:
- Displays `ContentDelta` as live text on stdout.
- On `ToolCallEvent`: displays the tool call, and for `ask_user` prompts for user input and injects via `generator.send(answer)`.
- On `ToolResultEvent`: displays the tool result.
- On `StreamComplete`: prints a stats line (model, time, tokens).
- See [docs/cli.md](cli.md) for details.
