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
- Conflicting `session_id` values (header vs body)
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

Raised when `POST /api/chat/sync/continue` or `POST /api/chat/stream/continue` is called on a session that is not in paused state.

**Trigger conditions:**
- Session not found in the store
- Session exists but `is_paused` is `False`

**Display message:** `"Session is not paused."`

## HTTP Status Code Mapping

Pydantic request body validation (blank `message` / `agent_id`) happens before domain logic and returns **422** by FastAPI default. Domain errors are caught in the endpoint handler:

| Error Source | HTTP Status |
|:---|:---|
| Pydantic validation (blank `message`, blank `agent_id`) | 422 |
| `ValidationError` | 400 |
| `SessionNotFoundError` | 404 |
| `SessionNotPausedError` | 400 |
| `AuthenticationError` | 500 (uncaught → FastAPI default) |
| `RateLimitError` | 500 (uncaught → FastAPI default) |
| `LLMError` | 500 (uncaught → FastAPI default) |

The FastAPI adapter explicitly catches `SessionNotFoundError` → 404 and `ValidationError` → 400. Pydantic validation errors (blank fields) return 422 before reaching the handler. All other exceptions propagate and FastAPI returns 500.

```python
# adapters/http/api.py
except SessionNotFoundError as error:
    raise HTTPException(status_code=404, detail=error.display_message)
except ValidationError as error:
    raise HTTPException(status_code=400, detail=error.display_message)
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
