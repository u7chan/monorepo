# HTTP API

The HTTP API provides streaming-only agent execution over Server-Sent Events (SSE), plus a pause/resume flow for interactive `ask_user` tool calls.

## Entry Point

```bash
uv run api
```

Starts Uvicorn on `127.0.0.1:8000`. Source: `src/simple_agent_poc/entrypoints/main_api.py`

## Application Factory

`create_app(use_case_factory, agent_definitions)` in `src/simple_agent_poc/adapters/http/api.py` creates the FastAPI application:

- If no use case factory is provided, calls `bootstrap.create_run_agent_use_case_factory()` which creates a shared `InMemorySessionStore` instance with a `lambda` factory.
- If no agent definition registry is provided, calls `bootstrap.create_agent_definition_registry()` for `/api/agents`.
- A FastAPI dependency `get_run_agent_use_case()` provides a fresh `RunAgentUseCase` per request, while sharing the session store.

## Endpoints

### `POST /api/chat`

Streaming agent execution via SSE. Supports tool calls, conversation continuation, and `ask_user` pauses.

#### Request

```json
{
  "message": "Hello",
  "session_id": "abc123...",
  "agent_id": "default"
}
```

| Field | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `message` | `str` | yes | - | User message. Must not be blank after trimming. |
| `session_id` | `str \| null` | no | `null` | Resume an existing conversation. |
| `agent_id` | `str` | no | `"default"` | Agent to use. Must not be blank. |

Headers:
- `Session-Id: <session_id>` (optional) - Primary session transport. Takes priority over body `session_id`.

#### Response

Media type: `text/event-stream`

See [docs/sse.md](sse.md) for the full SSE event specification.

Normal completion emits:

1. `event: delta` zero or more times for text chunks
2. `event: tool_call` and `event: tool_result` when tools are used
3. `event: complete` with `session_id`, `usage`, `model`, and `response_time`
4. `event: done`

When `ask_user` is called in API mode, the stream emits tool events, then:

1. `event: paused` with `session_id`, `call_id`, and `questions`
2. `event: done`

The client must call `POST /api/chat/continue` with the returned `session_id` and answers.

#### Error Responses

Request body validation errors return normal FastAPI HTTP errors before the stream starts:

| Status | Condition |
|:---|:---|
| `422` | `message` blank, `agent_id` blank (Pydantic validation) |
| `400` | conflicting `session_id` values between `Session-Id` header and request body |

Runtime errors are delivered as SSE `error` events:

| Error | Detail |
|:---|:---|
| `ValidationError` | unknown `agent_id`, changing `agent_id` for existing session |
| `SessionNotFoundError` | `session_id` not found in the session store |
| Other exceptions | string form of the exception |

### `POST /api/chat/continue`

Resumes a paused session after an `ask_user` event. Returns SSE events.

#### Request

```json
{
  "session_id": "abc123...",
  "answers": {"What is your name?": "My name is Alice"}
}
```

| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `session_id` | `str` | yes | The session ID from the `paused` event |
| `answers` | `dict[str,str]` | yes | User's answers to the `ask_user` questions, keyed by question text |

#### Response

Media type: `text/event-stream`

The first events are `tool_result` events for the supplied `ask_user` answers. The resumed ReAct loop then continues with `delta`, `tool_call`, `tool_result`, `complete`, and `done` events as needed.

If another `ask_user` call occurs during the resumed loop, the endpoint emits another `paused` event and then `done`.

#### Error Responses

Request body validation errors return normal FastAPI HTTP errors before the stream starts:

| Status | Condition |
|:---|:---|
| `422` | `session_id` blank or `answers` empty/invalid |

Runtime errors are delivered as SSE `error` events:

| Error | Detail |
|:---|:---|
| `SessionNotFoundError` | session does not exist |
| `SessionNotPausedError` | session exists but is not paused |
| `ValidationError` | invalid resume request |
| Other exceptions | string form of the exception |

### `GET /api/agents`

Returns the available agent definitions.

```json
{
  "agents": [
    {"id": "default", "model": "gpt-4.1-nano"}
  ]
}
```

### `GET /`

Returns the development test page as HTML.

## Session Resolution

`resolve_session_id(header_session_id, body_session_id)` resolves the effective session ID:

```python
def resolve_session_id(*, header_session_id, body_session_id):
    if header_session_id is None:
        return body_session_id          # use body only
    if body_session_id is None or body_session_id == header_session_id:
        return header_session_id        # use header (match)
    raise HTTPException(400, "Conflicting session_id values...")
```

## Dependency Injection

The FastAPI app uses `Depends(get_run_agent_use_case)` to inject `RunAgentUseCase` into endpoint handlers. The factory is created once at app startup via `create_run_agent_use_case_factory()`, ensuring the same `InMemorySessionStore` instance is shared across all requests.
