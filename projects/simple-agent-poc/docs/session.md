# Session Model

Sessions track conversation history across multiple requests. Each session is tied to a specific `agent_id` and accumulates messages in order.

## ConversationSession

```python
@dataclass(slots=True)
class ConversationSession:
    session_id: str          # UUID hex string
    agent_id: str = "default"
    messages: list[Message]   # [system, user, assistant, user, ...]
```

Source: `src/simple_agent_poc/core/session.py`

### Message Order

1. Session is created with the system prompt as the first message (`role: "system"`).
2. Each user turn appends a `role: "user"` message.
3. The LLM response appends a `role: "assistant"` message.
4. This cycle repeats for the lifetime of the session.

### Session Creation

`ConversationSession.start(session_id, agent_id, system_prompt)` creates a new session with:
- A generated `session_id` (UUID hex via `uuid4().hex`)
- The agent's `agent_id`
- One initial message: `{"role": "system", "content": system_prompt}`

The system prompt is obtained from `AgentDefinition.format_system_prompt(current_datetime=...)`, which replaces the `{current_datetime}` placeholder.

## SessionStore

Protocol defined in `src/simple_agent_poc/application/ports.py`:

```python
class SessionStore(Protocol):
    def get(self, session_id: str) -> ConversationSession | None: ...
    def save(self, session: ConversationSession) -> None: ...
```

### InMemorySessionStore

Default implementation in `src/simple_agent_poc/adapters/session_store/in_memory.py`. Stores sessions in a `dict[str, ConversationSession]` in process memory.

- **CLI**: Each invocation creates a new `InMemorySessionStore` instance.
- **HTTP**: A single shared instance is created by `create_run_agent_use_case_factory()` and reused across requests via `lambda`.

## Session Transport

### CLI

The `CLIAdapter` tracks the current `session_id` in its `_session_id` field. After each call to `execute()` or `execute_stream()`, it updates `_session_id` from the response's `session_id` field.

### HTTP

Sessions are transported via two mechanisms, with the header taking priority:

1. **`Session-Id` header** (primary) — the recommended way to resume a session.
2. **`session_id` in JSON body** (compatibility) — retained for backward compatibility.

`resolve_session_id(header_session_id, body_session_id)` resolves the effective session ID:
- If only header is present → use header
- If only body is present → use body
- If both are present and match → use header
- If both are present and differ → HTTP 400

## Agent ID Immutability

Once a session is created with a given `agent_id`, all subsequent requests for that `session_id` must use the same `agent_id`. Changing it returns `ValidationError` (HTTP 400).

This is enforced in `RunAgentUseCase._load_session()`:
```python
if session.agent_id != agent_definition.agent_id:
    raise ValidationError("agent_id cannot be changed for an existing session")
```

## Future Persistence

To add durable persistence:
1. Create a new class implementing `SessionStore` in `adapters/session_store/`.
2. Wire it in `entrypoints/bootstrap.py` instead of `InMemorySessionStore`.
3. Do not change `RunAgentUseCase` semantics.
