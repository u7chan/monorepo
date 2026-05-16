# SSE Streaming

Server-Sent Events (SSE) provide real-time streaming of agent responses via the `/api/chat/stream` endpoint. Both CLI and HTTP use the same underlying `RunAgentUseCase.execute_stream()` generator — only the formatting differs.

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

Emitted after `complete` to signal the end of the SSE stream. Contains an empty JSON object.

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

In `adapters/http/api.py`, the `chat_stream` endpoint wraps `execute_stream()` in a `StreamingResponse` generator:

```python
def event_stream():
    for event in run_agent.execute_stream(request):
        if isinstance(event, ContentDelta):
            yield f"event: delta\ndata: {json.dumps({'content': event.delta})}\n\n"
        elif isinstance(event, StreamComplete):
            yield f"event: complete\ndata: {json.dumps(asdict(event))}\n\n"
    yield "event: done\ndata: {}\n\n"
```

Errors caught:
- `SessionNotFoundError` → `event: error` with 404 detail
- `ValidationError` → `event: error` with 400 detail
- Generic `Exception` → `event: error` with the error string

## execute_stream() Generator Behavior

Source: `src/simple_agent_poc/application/use_cases.py:60-108`

1. Validates the message.
2. Loads or creates a session (same as `execute()`).
3. Validates `agent_id` immutability.
4. Appends the user message to the session.
5. Opens the LLM stream via `llm_client.complete_stream(messages)`.
6. For each chunk:
   - If `content_delta` is present → accumulates text, yields `ContentDelta(delta=...)`.
   - If `usage` is present → stores it in `usage_from_stream`.
7. After the stream ends:
   - Appends the accumulated text to the session as an assistant message.
   - Yields `StreamComplete(...)` with the session metadata.
8. In `finally`: saves the session to the session store.

### Error Handling During Streaming

If the stream raises an exception:

- **Text was accumulated**: Appends `"{accumulated_text}\n\n[stream interrupted]"` to the session.
- **No text was accumulated**: Appends `"[stream interrupted]"` to the session.
- The exception is re-raised after saving.

The `finally` block ensures the session is always persisted, even on failure.

## CLI Streaming

In CLI mode, `show_streaming_response()` consumes the same `execute_stream()` generator:
- Displays `ContentDelta` as live text on stdout.
- On `StreamComplete`, prints a stats line (model, time, tokens).
- See [docs/cli.md](cli.md) for details.
