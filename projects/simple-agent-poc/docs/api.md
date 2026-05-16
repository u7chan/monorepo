# HTTP API

The HTTP API provides two endpoints for synchronous and streaming agent execution.

## Entry Point

```bash
uv run api
```

Starts Uvicorn on `127.0.0.1:8000`. Source: `src/simple_agent_poc/entrypoints/main_api.py`

## Application Factory

`create_app(use_case_factory)` in `src/simple_agent_poc/adapters/http/api.py` creates the FastAPI application:

- If no factory is provided, calls `bootstrap.create_run_agent_use_case_factory()` which creates a shared `InMemorySessionStore` instance with a `lambda` factory.
- A FastAPI dependency `get_run_agent_use_case()` provides a fresh `RunAgentUseCase` per request (with the shared session store).

## Endpoints

### `POST /api/chat`

Synchronous (non-streaming) agent execution.

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
| `message` | `str` | yes | — | User message. Must not be blank after trimming. |
| `session_id` | `str \| null` | no | `null` | Resume an existing conversation. |
| `agent_id` | `str` | no | `"default"` | Agent to use. Must not be blank. |

Headers:
- `Session-Id: <session_id>` (optional) — Primary session transport. Takes priority over body `session_id`.

#### Response (200)

```json
{
  "message": "Hello! How can I help?",
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 20,
    "total_tokens": 70
  },
  "model": "gpt-4.1-nano",
  "response_time": 1.234,
  "session_id": "abc123..."
}
```

| Field | Type | Description |
|:---|:---|:---|
| `message` | `str` | Agent's full response text |
| `usage` | `Usage` | Token usage: `prompt_tokens`, `completion_tokens`, `total_tokens` |
| `model` | `str` | Model name as configured |
| `response_time` | `float` | Seconds from LLM call start to response receipt |
| `session_id` | `str` | Session ID for continuing the conversation |

#### Error Responses

| Status | Condition |
|:---|:---|
| `422` | `message` blank, `agent_id` blank (Pydantic validation) |
| `400` | unknown `agent_id`, changing `agent_id` for existing session, conflicting session identifiers |
| `404` | `session_id` not found in the session store |

### `POST /api/chat/stream`

Streaming agent execution via Server-Sent Events (SSE).

#### Request

Same schema as `/api/chat`. Supports `Session-Id` header with the same `resolve_session_id()` logic.

#### Response

Media type: `text/event-stream`

See [docs/sse.md](sse.md) for the full SSE event specification.

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
