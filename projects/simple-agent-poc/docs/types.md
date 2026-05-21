# Type Definitions

Core types and DTOs used across the application. This document describes the conceptual purpose and relationships of each type. For exact signatures, see the canonical source files referenced in each section.

## Core Types

Source: `src/simple_agent_poc/core/types.py`

### MessageRole

```python
MessageRole = Literal["system", "user", "assistant", "tool"]
```

The `"tool"` role is used for tool result messages appended to the conversation after a tool call.

### ToolCallFunction / ToolCall

```python
class ToolCallFunction(TypedDict):   # {name, arguments}
class ToolCall(TypedDict):           # {id, type: "function", function: ToolCallFunction}
```

Represents a tool call requested by the LLM. `arguments` is a JSON string.

### ToolFunctionDef / ToolDefinition

```python
class ToolFunctionDef(TypedDict):    # {name, description, parameters}
class ToolDefinition(TypedDict):     # {type: "function", function: ToolFunctionDef}
```

Defines a tool's JSON Schema that is sent to the LLM. `parameters` is a JSON Schema object describing the tool's input.

### ToolCallFunctionDelta / ToolCallDelta

```python
class ToolCallFunctionDelta(TypedDict):  # {name?, arguments?}
class ToolCallDelta(TypedDict):          # {index, id?, type, function: ToolCallFunctionDelta}
```

Streaming deltas for incremental tool call construction. The LLM emits these chunks when streaming a tool call; they are accumulated into a full `ToolCall`.

### Message

```python
class Message(TypedDict):
    role: MessageRole
    content: str
    tool_calls: NotRequired[list[ToolCall]]
    tool_call_id: NotRequired[str]
```

`tool_calls` is present on assistant messages that call tools. `tool_call_id` is present on tool messages and links the result to the original call.

### Usage

```python
class Usage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
```

### LLMStreamChunk

```python
class LLMStreamChunk(TypedDict):
    content_delta: str | None
    tool_call_delta: NotRequired[ToolCallDelta]
    usage: NotRequired[Usage]
```

- `content_delta`: incremental text. `None` when the chunk contains only tool call or usage info.
- `tool_call_delta`: present during streaming tool call construction.
- `usage`: token usage. Only present in final chunks that include usage metadata.

### Domain Errors

```
AgentError (base)
├── AuthenticationError
├── RateLimitError
├── LLMError
├── ValidationError
├── SessionNotFoundError
└── SessionNotPausedError
```

`SessionNotPausedError` is raised when `POST /api/chat/continue` is called on a session that is not in paused state. See [docs/errors.md](errors.md).

## Application DTOs

Source: `src/simple_agent_poc/application/dto.py`

### RunAgentRequest

```python
@dataclass(frozen=True, slots=True)
class RunAgentRequest:
    message: str
    session_id: str | None = None
    agent_id: str = "default"
```

### Stream Events

These are yielded by `execute_stream()` and `continue_stream()` generators:

| Event | Description |
|:---|:---|
| `ContentDelta(delta)` | Partial text chunk during streaming |
| `ToolCallEvent(call_id, name, arguments)` | Agent has initiated a tool call |
| `ToolResultEvent(call_id, name, result)` | Tool execution completed |
| `SessionPaused(session_id, call_id, questions)` | `ask_user` called in API mode; stream pauses |
| `StreamComplete(session_id, usage, model, response_time)` | Stream finished successfully |

### ContinueRequest

```python
@dataclass(frozen=True, slots=True)
class ContinueRequest:
    session_id: str
    answers: dict[str, str]
```

Request DTO for resuming a paused session. Contains the user's answers dict keyed by question text.

## HTTP Schemas

Source: `src/simple_agent_poc/adapters/http/api.py`

### ChatRequest

```python
class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    agent_id: str = "default"
```

Validators reject blank `message` and blank `agent_id` after stripping.

### ResumeRequest

```python
class ResumeRequest(BaseModel):
    session_id: str
    answers: dict[str, str]
```

Used by `POST /api/chat/continue`. Validators reject blank `session_id` and empty `answers` dict.

## Entity

### ConversationSession

Source: `src/simple_agent_poc/core/session.py`

```python
@dataclass(slots=True)
class ConversationSession:
    session_id: str
    agent_id: str = "default"
    messages: list[Message] = field(default_factory=list)
    is_paused: bool = False
    pending_tool_call: ToolCall | None = None
    pending_round: int = 0
```

Factory method: `start(*, session_id, agent_id, system_prompt)`.

Methods:
- `append_user_message(content)` / `append_assistant_message(content)` - append user/assistant messages
- `append_tool_message(result, *, tool_call_id)` - append a tool result message (role: `"tool"`)
- `replace_tool_message(result, *, tool_call_id)` - replace a pending placeholder tool message
- `pause_for_ask_user(tool_call, *, round_idx)` - set `is_paused=True`, save the pending tool call and round count
- `resume_with_answer()` - clear paused state

### AgentDefinition

Source: `src/simple_agent_poc/core/agent_definition.py`

```python
@dataclass(frozen=True, slots=True)
class AgentDefinition:
    agent_id: str
    model: str
    system_prompt: str
    temperature: float | None = None
    tools: list[str] = field(default_factory=list)
    api_type: Literal["completion", "responses"] = "completion"
    max_tool_rounds: int = 5
```

Method: `format_system_prompt(*, current_datetime)` replaces the `{current_datetime}` placeholder.

### AgentDefinitionRegistry

```python
@dataclass(frozen=True, slots=True)
class AgentDefinitionRegistry:
    _definitions: Mapping[str, AgentDefinition]
```

Factory methods: `from_yaml_file(path)`, `from_mapping(data)`.
Query methods: `get(agent_id)`, `list_ids()`, `list_agents()`.

## Ports (Protocols)

Source: `src/simple_agent_poc/application/ports.py`

### ToolExecutor

```python
class ToolExecutor(Protocol):
    def execute(self, tool_call: ToolCall, /) -> str: ...
    def get_definitions(self, tool_names: list[str], /) -> list[ToolDefinition]: ...
```

Implemented by `BuiltinToolRegistry` in `src/simple_agent_poc/adapters/tools/registry.py`.

### LLMClient

```python
class LLMClient(Protocol):
    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]: ...
```

### LLMClientFactory / SessionStore

See [docs/llm-integration.md](llm-integration.md) and [docs/session.md](session.md).
