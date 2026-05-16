# Type Definitions

All core types and DTOs used across the application.

## Core Types

Source: `src/simple_agent_poc/core/types.py`

### MessageRole

```python
MessageRole = Literal["system", "user", "assistant"]
```

### Message

```python
class Message(TypedDict):
    role: MessageRole
    content: str
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
```

### LLMStreamChunk

```python
class LLMStreamChunk(TypedDict):
    content_delta: str | None
    usage: NotRequired[Usage]
```

- `content_delta`: The incremental text. `None` when the chunk contains only usage info.
- `usage`: Token usage. Only present in final chunks that include usage metadata.

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

### RunAgentResponse

```python
@dataclass(frozen=True, slots=True)
class RunAgentResponse:
    message: str
    usage: Usage
    model: str
    response_time: float
    session_id: str
```

Factory method:
```python
@classmethod
def from_llm_response(cls, response: LLMResponse, *, session_id: str) -> "RunAgentResponse"
```

### ContentDelta

```python
@dataclass(frozen=True, slots=True)
class ContentDelta:
    delta: str
```

Emitted during streaming for each text chunk.

### StreamComplete

```python
@dataclass(frozen=True, slots=True)
class StreamComplete:
    session_id: str
    usage: Usage | None
    model: str
    response_time: float
```

Emitted when a stream finishes successfully. `usage` may be `None` if the LLM did not provide token counts.

## HTTP Schemas

Source: `src/simple_agent_poc/adapters/http/api.py`

### ChatRequest

```python
class ChatRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    message: str
    session_id: str | None = None
    agent_id: str = "default"
```

Validators:
- `message`: rejected if blank after stripping
- `agent_id`: rejected if blank after stripping

### ChatResponse

```python
class ChatResponse(BaseModel):
    message: str
    usage: Usage
    model: str
    response_time: float
    session_id: str
```

Factory method:
```python
@classmethod
def from_use_case_response(cls, response: RunAgentResponse) -> "ChatResponse"
```

## Entity

Source: `src/simple_agent_poc/core/session.py`

### ConversationSession

```python
@dataclass(slots=True)
class ConversationSession:
    session_id: str
    agent_id: str = "default"
    messages: list[Message] = field(default_factory=list)
```

Factory method:
```python
@classmethod
def start(cls, *, session_id: str, agent_id: str, system_prompt: str) -> "ConversationSession"
```

Methods:
- `append_user_message(content: str) -> None`
- `append_assistant_message(content: str) -> None`

### AgentDefinition

```python
@dataclass(frozen=True, slots=True)
class AgentDefinition:
    agent_id: str
    model: str
    system_prompt: str
    temperature: float | None = None
    tools: list[dict[str, Any]] = field(default_factory=list)
    api_type: Literal["completion", "responses"] = "completion"
    stream: bool = False
```

Method:
```python
def format_system_prompt(self, *, current_datetime: str) -> str
```

### AgentDefinitionRegistry

```python
@dataclass(frozen=True, slots=True)
class AgentDefinitionRegistry:
    _definitions: Mapping[str, AgentDefinition]
```

Factory methods:
```python
@classmethod
def from_yaml_file(cls, path: str | Path) -> "AgentDefinitionRegistry"
@classmethod
def from_mapping(cls, data: object) -> "AgentDefinitionRegistry"
```

Query method:
```python
def get(self, agent_id: str) -> AgentDefinition
```
