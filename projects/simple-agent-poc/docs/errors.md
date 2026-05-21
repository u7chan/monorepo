# Error Handling

## Error Hierarchy

Source: `src/simple_agent_poc/core/types.py`

```
AgentError (base)
├── AuthenticationError
├── RateLimitError
├── LLMError
├── ValidationError
├── SessionNotFoundError
└── SessionNotPausedError
```

### AgentError

```python
class AgentError(Exception):
    def __init__(self, message: str, display_message: str | None = None):
        ...
        self.display_message = display_message or message
```

All domain exceptions inherit from `AgentError`. Each has:
- `message` (technical, internal)
- `display_message` (user-facing, safe to display)

### AuthenticationError

Raised when LLM API authentication fails (invalid API key, 401).

**Trigger conditions in `litellm_client.py`:**
- `litellm.exceptions.AuthenticationError` is caught
- Generic exception message contains `"authentication"`, `"api key"`, or `"401"`

**Display message:** `"Authentication failed: Invalid API key. Please check your API_KEY setting."`

### RateLimitError

Raised when the LLM API rate limit is exceeded.

**Trigger condition:** `litellm.exceptions.RateLimitError` is caught.

**Display message:** `"Rate limit exceeded. Please wait a moment before trying again."`

### LLMError

Raised for any LLM communication error not covered by more specific types.

**Trigger condition:** Any exception from LiteLLM that is not authentication or rate-limit related.

**Display message:** `"An error occurred while communicating with the LLM: {error}"`

### ValidationError

Raised for input validation failures.

**Trigger conditions:**
- Blank message in request
- Blank `agent_id` in request
- `agent_id` not found in the registry
- Changing `agent_id` for an existing session
- YAML file parsing errors
- Malformed agent definitions (missing required fields, wrong types, unknown fields)

**Display message:** Varies by context. Examples:
- `"message must not be blank"`
- `"Unknown agent_id: foo"`
- `"agent_id cannot be changed for an existing session"`

### SessionNotFoundError

Raised when a requested `session_id` does not exist in the session store.

**Display message:** `"Session not found."`

### SessionNotPausedError

Raised when `POST /api/chat/continue` is called on a session that is not in paused state.

**Trigger conditions:**
- Session not found in the store
- Session exists but `is_paused` is `False`

**Display message:** `"Session is not in a paused state."`

## HTTP and SSE Mapping

Both chat endpoints return `text/event-stream` for normal execution. Request schema validation happens before streaming starts and returns a normal FastAPI HTTP response. Runtime errors from the agent flow are emitted as SSE `error` events.

| Error Source | Transport |
|:---|:---|
| Pydantic validation (blank `message`, blank `agent_id`, blank `session_id`, empty `answers`) | HTTP 422 |
| Conflicting `Session-Id` header and body `session_id` | HTTP 400 |
| `ValidationError` inside execution | SSE `error` event |
| `SessionNotFoundError` inside execution | SSE `error` event |
| `SessionNotPausedError` inside resume execution | SSE `error` event |
| `AuthenticationError`, `RateLimitError`, `LLMError`, or other exceptions | SSE `error` event |

`resolve_session_id()` raises `HTTPException(400)` before `StreamingResponse` is created when the header and body session IDs conflict.

```python
# adapters/http/api.py:resolve_session_id
raise HTTPException(
    status_code=400,
    detail="Conflicting session_id values were provided...",
)
```

## CLI Error Display

```python
# adapters/cli/renderer.py:show_error
def show_error(error: Exception) -> None:
    if isinstance(error, AgentError):
        print(f"⚠️  Error: {error.display_message}")
    else:
        print(f"⚠️  Error: An unexpected error occurred: {error}")
```

- `AgentError` subclasses: shows the `display_message` (user-friendly).
- Other exceptions: shows the raw error string.
- The CLI loop continues after displaying the error.

## SSE Error Handling

```python
# adapters/http/api.py:event_stream
except SessionNotFoundError as error:
    yield f"event: error\ndata: {json.dumps({'detail': error.display_message})}\n\n"
except ValidationError as error:
    yield f"event: error\ndata: {json.dumps({'detail': error.display_message})}\n\n"
except Exception as error:
    yield f"event: error\ndata: {json.dumps({'detail': str(error)})}\n\n"
```

Errors during streaming are emitted as SSE `error` events rather than HTTP error responses. The stream terminates after the error event.
