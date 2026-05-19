# HTTP API

The HTTP API provides endpoints for synchronous and streaming agent execution, plus a pause/resume flow for interactive tool calls.

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

### `POST /api/chat/sync`

Synchronous (non-streaming) agent execution. Supports tool calls via the ReAct loop and `ask_user` pause/resume.

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

#### Response (200) — completed

When the agent finishes normally:

```json
{
  "status": "completed",
  "message": "Hello! How can I help?",
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 20,
    "total_tokens": 70
  },
  "model": "gpt-4.1-nano",
  "response_time": 1.234,
  "session_id": "abc123...",
  "tool_calls": [
    {
      "call_id": "call_abc123",
      "name": "concat",
      "arguments": "{\"a\":\"Hello\",\"b\":\"World\"}",
      "result": "HelloWorld"
    }
  ]
}
```

| Field | Type | Description |
|:---|:---|:---|
| `status` | `"completed"` | Discriminator for a completed response |
| `message` | `str` | Agent's full response text |
| `usage` | `Usage?` | Token usage: `prompt_tokens`, `completion_tokens`, `total_tokens` |
| `model` | `str` | Model name as configured |
| `response_time` | `float` | Seconds from LLM call start to response receipt |
| `session_id` | `str` | Session ID for continuing the conversation |
| `tool_calls` | `list[ToolCallRecord]` | Tool calls made during execution with their results |

#### Response (200) — paused

When the agent calls `ask_user` and needs user input:

```json
{
  "status": "paused",
  "session_id": "abc123...",
  "call_id": "call_001",
  "questions": [
    {
      "question": "What is your name?",
      "header": "Name",
      "type": "text",
      "placeholder": "e.g. Alice"
    },
    {
      "question": "Which database?",
      "header": "Database",
      "type": "choice",
      "options": [
        {"label": "PostgreSQL", "description": "OSS RDBMS"},
        {"label": "SQLite", "description": "Lightweight embedded DB"}
      ],
      "multiSelect": false
    }
  ],
  "tool_calls": []
}
```

| Field | Type | Description |
|:---|:---|:---|
| `status` | `"paused"` | Discriminator for a paused response |
| `session_id` | `str` | Session ID for continuing the conversation |
| `call_id` | `str` | ID of the pending `ask_user` tool call |
| `questions` | `list[dict]` | Question items from `ask_user` arguments. Each item has `question`, `header`, `type` (`"text"` or `"choice"`), optional `placeholder`, and for `type: "choice"` also `options` and `multiSelect` |
| `tool_calls` | `list[ToolCallRecord]` | Non-ask_user tool calls executed before pausing |

**`type: "choice"`** の場合、各 `options` エントリは `label`（必須）と `description`（任意）を持つ。`multiSelect: true` の場合、クライアントはカンマ区切りで複数の選択番号を送信できる。

#### Error Responses

| Status | Condition |
|:---|:---|
| `422` | `message` blank, `agent_id` blank (Pydantic validation) |
| `400` | unknown `agent_id`, changing `agent_id` for existing session, conflicting session identifiers |
| `404` | `session_id` not found in the session store |

### `POST /api/chat/sync/continue`

Resumes a paused session synchronously. Returns the same discriminated shape as `/api/chat/sync`.

#### Request

```json
{
  "session_id": "abc123...",
  "answers": {"What is your name?": "My name is Alice"}
}
```

| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `session_id` | `str` | yes | The session ID from the `paused` response |
| `answers` | `dict[str,str]` | yes | User's answers to the `ask_user` questions, keyed by question text |

#### Response (200)

Same discriminated shape as `/api/chat/sync` (either `"completed"` or `"paused"`). All `ask_user` tool calls in the same assistant response are answered together; the session will not pause again for unanswered calls in the same batch.

#### Error Responses

| Status | Condition |
|:---|:---|
| `422` | `session_id` or `answers` blank/invalid (Pydantic validation) |
| `400` | session is not paused |
| `404` | `session_id` not found |

### `POST /api/chat/stream`

Streaming agent execution via Server-Sent Events (SSE). Supports tool calls, and may disconnect with `paused` event when `ask_user` is called.

#### Request

Same schema as `/api/chat/sync`. Supports `Session-Id` header with the same `resolve_session_id()` logic.

#### Response

Media type: `text/event-stream`

See [docs/sse.md](sse.md) for the full SSE event specification.

### `POST /api/chat/stream/continue`

Resumes a paused session (after `ask_user` was called in streaming mode). Returns SSE events.

#### Request

```json
{
  "session_id": "abc123...",
  "answers": {"Your preference?": "My preference is X"}
}
```

| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `session_id` | `str` | yes | The session ID from the `paused` event |
| `answers` | `dict[str,str]` | yes | User's answers to the `ask_user` questions, keyed by question text |

#### Response

Same SSE format as `/api/chat/stream`. The sequence is:
1. `event: tool_result` — the answers injected as tool results
2. `event: delta` ... — LLM response chunks (ReAct loop resumes)
3. `event: complete` — stream finished
4. `event: done` — end of stream

If another `ask_user` is called during the resumed ReAct loop, `event: paused` is emitted again.

#### Error Responses

Errors are delivered as SSE `error` events within the stream.

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
