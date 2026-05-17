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
    role: MessageRole            # "system" | "user" | "assistant" | "tool"
    content: str
    tool_calls: NotRequired[list[ToolCall]]   # present on assistant messages that call tools
    tool_call_id: NotRequired[str]            # present on tool messages, links to the call
```

### Usage

```python
class Usage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
```

### LLMResponse

```python
class LLMResponse(TypedDict):
    content: str
    usage: Usage
    model: str
    response_time: float
    tool_calls: NotRequired[list[ToolCall]]
```

`content` may be empty when the LLM returns only tool calls. `tool_calls` is present when the LLM requests tool execution.

### LLMStreamChunk

```python
class LLMStreamChunk(TypedDict):
    content_delta: str | None
    tool_call_delta: NotRequired[ToolCallDelta]
    usage: NotRequired[Usage]
```

- `content_delta`: Incremental text. `None` when the chunk contains only tool call or usage info.
- `tool_call_delta`: Present during streaming tool call construction.
- `usage`: Token usage. Only present in final chunks that include usage metadata.

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

`SessionNotPausedError` — raised when `POST /api/chat/continue` is called on a session that is not in paused state. See [docs/errors.md](errors.md).

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

### ToolCallRecord

```python
@dataclass(frozen=True, slots=True)
class ToolCallRecord:
    call_id: str
    name: str
    arguments: str
    result: str
```

A single tool call and its result. Collected during agent execution and included in the final response.

### RunAgentResponse

```python
@dataclass(frozen=True, slots=True)
class RunAgentResponse:
    message: str
    usage: Usage
    model: str
    response_time: float
    session_id: str
    tool_call_history: list[ToolCallRecord]
```

Factory method: `from_llm_response(response, *, session_id, tool_call_history=None)`.

### Stream Events

These are yielded by `execute_stream()` and `continue_stream()` generators:

| Event | Description |
|:---|:---|
| `ContentDelta(delta)` | Partial text chunk during streaming |
| `ToolCallEvent(call_id, name, arguments)` | Agent has initiated a tool call |
| `ToolResultEvent(call_id, name, result)` | Tool execution completed |
| `SessionPaused(session_id, call_id, question)` | `ask_user` called in API mode; stream pauses |
| `StreamComplete(session_id, usage, model, response_time)` | Stream finished successfully |

### ContinueRequest

```python
@dataclass(frozen=True, slots=True)
class ContinueRequest:
    session_id: str
    answer: str
```

Request DTO for `POST /api/chat/continue`. Contains the user's answer to an `ask_user` question.

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

### ChatResponse

```python
class ChatResponse(BaseModel):
    message: str
    usage: Usage
    model: str
    response_time: float
    session_id: str
    tool_calls: list[ToolCallRecord]
```

Factory method: `from_use_case_response(response)`.

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
- `append_user_message(content)` / `append_assistant_message(content)` — append user/assistant messages
- `append_tool_message(result, *, tool_call_id)` — append a tool result message (role: `"tool"`)
- `pause_for_ask_user(tool_call)` — set `is_paused=True`, save the pending tool call
- `resume_with_answer(answer)` — clear paused state

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
    stream: bool = False
```

Method: `format_system_prompt(*, current_datetime)` — replaces `{current_datetime}` placeholder.

### AgentDefinitionRegistry

```python
@dataclass(frozen=True, slots=True)
class AgentDefinitionRegistry:
    _definitions: Mapping[str, AgentDefinition]
```

Factory methods: `from_yaml_file(path)`, `from_mapping(data)`.
Query method: `get(agent_id)`.

## Ports (Protocols)

Source: `src/simple_agent_poc/application/ports.py`

### ToolExecutor

```python
class ToolExecutor(Protocol):
    def execute(self, tool_call: ToolCall) -> str: ...
    def get_definitions(self) -> list[ToolDefinition]: ...
```

Implemented by `BuiltinToolRegistry` in `src/simple_agent_poc/adapters/tools/registry.py`.

### LLMClient

```python
class LLMClient(Protocol):
    def complete(self, messages: list[Message], *, tools: list[ToolDefinition] | None = None) -> LLMResponse: ...
    def complete_stream(self, messages: list[Message], *, tools: list[ToolDefinition] | None = None) -> Iterator[LLMStreamChunk]: ...
```

### LLMClientFactory / SessionStore

See [docs/llm-integration.md](llm-integration.md) and [docs/session.md](session.md).
