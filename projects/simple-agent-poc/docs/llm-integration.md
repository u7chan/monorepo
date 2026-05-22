# LLM Integration (LiteLLM)

The LLM integration layer wraps LiteLLM behind protocol interfaces, allowing the application to work with different LLM APIs without changing use case logic. The runtime uses streaming-only LLM calls.

## Interfaces

Source: `src/simple_agent_poc/application/ports.py`

```python
class LLMClient(Protocol):
    def complete_stream(
        self,
        messages: list[Message],
        *,
        tools: list[ToolDefinition] | None = None,
    ) -> Iterator[LLMStreamChunk]: ...

class LLMClientFactory(Protocol):
    def __call__(self, agent_definition: AgentDefinition) -> LLMClient: ...
```

The `tools` parameter carries tool definitions resolved from the agent's `tools` list. When `None` or empty, no tools are sent to the LLM.

## Agent ReAct Loop

`RunAgentUseCase` owns orchestration around the LLM client. For each user message, it sends the current session messages to the selected client, streams response chunks, records the assistant response, executes requested tools, appends tool results, and calls the LLM again. This ReAct loop continues until the LLM returns a final text response without tool calls.

The loop limit comes from the selected agent definition's `max_tool_rounds` field in `agents.yaml`. The default is `5`, and startup validation restricts configured values to integers from `1` to `20`. This keeps provider-specific LLM clients focused on API translation while agent-level behavior such as tool-loop depth remains in YAML and the application use case.

## LiteLLMClientFactory

Source: `src/simple_agent_poc/adapters/llm/litellm_client.py`

```python
class LiteLLMClientFactory:
    def __call__(self, agent_definition: AgentDefinition) -> LLMClient:
        if agent_definition.api_type == "responses":
            return LiteLLMResponsesClient(model=..., temperature=...)
        return LiteLLMCompletionClient(model=..., temperature=...)
```

The factory selects the client based on the agent's `api_type` field in `agents.yaml`.

## LiteLLMCompletionClient

Uses `litellm.completion()` with `stream=True` (OpenAI-compatible chat completions API).

| API | `api_type` |
|:---|:---|
| `completion` | `"completion"` (default) |

```python
response = completion(
    model=self.model,
    messages=messages,
    tools=formatted_tools or None,
    stream=True,
    stream_options={"include_usage": True},
    **completion_params,
)
for chunk in response:
    # chunk.choices[0].delta.content    -> content_delta
    # chunk.choices[0].delta.tool_calls -> tool_call_delta
    # chunk.usage                       -> usage info (if present)
```

Tool call deltas are accumulated across chunks and assembled into full `ToolCall` objects. The delta format follows OpenAI's streaming tool call convention with incremental `index`, `id`, `function.name`, and `function.arguments`.

## LiteLLMResponsesClient

Uses `litellm.responses()` with `stream=True` (OpenAI Responses API).

| API | `api_type` |
|:---|:---|
| `responses` | `"responses"` |

### Tool Format Transformation

Responses API uses a different tool definition format than Completion API. Tools are transformed via `_transform_tools_for_responses()`:

```python
# Completion API format -> Responses API format
{"type": "function", "function": {"name": ..., "description": ..., "parameters": ...}}
# becomes
{"type": "function_call", "name": ..., "description": ..., "parameters": ...}
```

Messages are also transformed via `_transform_messages_for_responses()` to convert `tool_calls` and `tool_call_id` fields into the Responses API's expected format.

### Streaming

```python
response = responses(
    input=transformed_messages,
    tools=transformed_tools or None,
    model=self.model,
    stream=True,
    **response_params,
)
for event in response:
    # event.delta          -> content_delta
    # tool call deltas     -> tool_call_delta
    # event.response.usage -> usage info (if present)
```

Note: `litellm.responses()` takes `input=` instead of `messages=`.

## Exception Translation

All LiteLLM-specific exceptions are translated to domain exceptions defined in `core/types.py`:

| LiteLLM Exception | Domain Exception | HTTP |
|:---|:---|:---|
| `AuthenticationError` (litellm) | `AuthenticationError` (domain) | SSE `error` event |
| `RateLimitError` (litellm) | `RateLimitError` (domain) | SSE `error` event |
| Generic with "authentication" / "api key" / "401" in message | `AuthenticationError` (domain) | SSE `error` event |
| Other generic exceptions | `LLMError` (domain) | SSE `error` event |

Each domain exception provides both a technical `message` and a user-facing `display_message`.

The display messages:
- Authentication: `"Authentication failed: Invalid API key. Please check your API_KEY setting."`
- Rate limit: `"Rate limit exceeded. Please wait a moment before trying again."`
- General: `"An error occurred while communicating with the LLM: {error}"`

## Temperature Handling

- `temperature` is `None` by default in `AgentDefinition`.
- When `None`, the temperature parameter is not included in the API call.
- When set to a float value, it is passed as `temperature=<value>`.

## Logging

LiteLLM's logger is silenced at module import time in `bootstrap.py`:

```python
logging.getLogger("litellm").setLevel(logging.CRITICAL)
logging.getLogger("litellm").addHandler(logging.NullHandler())
```
