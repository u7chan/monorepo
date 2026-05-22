# Session Model

Sessions track conversation history across multiple requests. Each session is tied to a specific `agent_id` and accumulates messages in order.

## ConversationSession

```python
@dataclass(slots=True)
class ConversationSession:
    session_id: str              # UUID hex string
    agent_id: str = "default"
    messages: list[Message]      # [system, user, assistant, tool, user, ...]
    is_paused: bool = False      # True when waiting for ask_user answer
    pending_tool_call: ToolCall | None = None  # saved tool call during pause
    pending_round: int = 0       # remaining ReAct rounds to resume
```

Source: `src/simple_agent_poc/core/session.py`

### Message Order

1. Session is created with the system prompt as the first message (`role: "system"`).
2. Each user turn appends a `role: "user"` message.
3. The LLM response appends a `role: "assistant"` message (may include `tool_calls`).
4. If the LLM calls a tool, a `role: "tool"` message is appended with the result and `tool_call_id`.
5. The ReAct loop may repeat steps 3-4 up to the agent definition's `max_tool_rounds` value (`5` by default).
6. This cycle continues for the lifetime of the session.

### Session Creation

`ConversationSession.start(session_id, agent_id, system_prompt)` creates a new session with:
- A generated `session_id` (UUID hex via `uuid4().hex`)
- The agent's `agent_id`
- One initial message: `{"role": "system", "content": system_prompt}`

The system prompt is obtained from `AgentDefinition.format_system_prompt(current_datetime=...)`, which replaces the `{current_datetime}` placeholder.

### Tool Messages

`append_tool_message(result, *, tool_call_id)` appends a message with `role: "tool"` and `content: result`, linked to the tool call by `tool_call_id`.

### Pause / Resume

When `ask_user` is called in API mode, the session enters a paused state:

- `pause_for_ask_user(tool_call, *, round_idx)` — sets `is_paused = True`, saves the `ToolCall` and current round count.
- `resume_with_answer()` — clears paused state. The user's answer is injected as a tool result by the use case.

Paused sessions are persisted via `SessionStore.save()`. HTTP clients resume via `POST /api/chat/continue`. See [docs/api.md](api.md) and [docs/sse.md](sse.md) for the API flow.

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

The `CLIAdapter` tracks the current `session_id` in its `_session_id` field. After each `execute_stream()` call completes, it updates `_session_id` from the `StreamComplete.session_id` field.

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
