# LLM Integration (LiteLLM)

The LLM integration layer wraps LiteLLM behind protocol interfaces, allowing the application to work with different LLM APIs without changing use case logic.

## Interfaces

Source: `src/simple_agent_poc/application/ports.py`

```python
class LLMClient(Protocol):
    def complete(self, messages: list[Message]) -> LLMResponse: ...
    def complete_stream(self, messages: list[Message]) -> Iterator[LLMStreamChunk]: ...

class LLMClientFactory(Protocol):
    def __call__(self, agent_definition: AgentDefinition) -> LLMClient: ...
```

## LiteLLMClientFactory

Source: `src/simple_agent_poc/adapters/llm/litellm_client.py:255-267`

```python
class LiteLLMClientFactory:
    def __call__(self, agent_definition: AgentDefinition) -> LLMClient:
        if agent_definition.api_type == "responses":
            return LiteLLMResponsesClient(model=..., temperature=...)
        return LiteLLMCompletionClient(model=..., temperature=...)
```

The factory selects the client based on the agent's `api_type` field in `agents.yaml`.

## LiteLLMCompletionClient

Uses `litellm.completion()` (OpenAI-compatible chat completions API).

| API | `api_type` |
|:---|:---|
| `completion` | `"completion"` (default) |

### synchronous (`complete`)

```python
response = completion(model=self.model, messages=messages, stream=False, **completion_params)
# returns response.choices[0].message.content
# returns response.usage (prompt_tokens, completion_tokens, total_tokens)
```

### streaming (`complete_stream`)

```python
response = completion(
    model=self.model, messages=messages, stream=True,
    stream_options={"include_usage": True}, **completion_params
)
for chunk in response:
    # chunk.choices[0].delta.content  → content_delta
    # chunk.usage                     → usage info (if present)
```

Usage info is included in the final chunk(s) via `stream_options={"include_usage": True}`.

## LiteLLMResponsesClient

Uses `litellm.responses()` (OpenAI Responses API).

| API | `api_type` |
|:---|:---|
| `responses` | `"responses"` |

### synchronous (`complete`)

```python
response = responses(input=messages, model=self.model, stream=False, **response_params)
# returns response.output_text
# returns response.usage (input_tokens, output_tokens, total_tokens)
```

Note: `litellm.responses()` takes `input=` (not `messages=`). The input format includes `role` and `content` keys.

### streaming (`complete_stream`)

```python
response = responses(input=messages, model=self.model, stream=True, **response_params)
for event in response:
    # event.delta            → content_delta
    # event.response.usage   → usage info (if present)
```

## Exception Translation

All LiteLLM-specific exceptions are translated to domain exceptions defined in `core/types.py`:

| LiteLLM Exception | Domain Exception | HTTP |
|:---|:---|:---|
| `AuthenticationError` (litellm) | `AuthenticationError` (domain) | 500 |
| `RateLimitError` (litellm) | `RateLimitError` (domain) | 500 |
| Generic with "authentication" / "api key" / "401" in message | `AuthenticationError` (domain) | 500 |
| Other generic exceptions | `LLMError` (domain) | 500 |

Each domain exception provides both a technical `message` and a user-facing `display_message`.

The display messages:
- Authentication: `"Authentication failed: Invalid API key. Please check your API_KEY setting."`
- Rate limit: `"Rate limit exceeded. Please wait a moment before trying again."`
- General: `"An error occurred while communicating with the LLM: {error}"`

## Temperature Handling

- `temperature` is `None` by default in `AgentDefinition`.
- When `None`, the temperature parameter is **not included** in the API call.
- When set to a float value, it is passed as `temperature=<value>`.

## Logging

LiteLLM's logger is silenced at module import time in `bootstrap.py`:

```python
logging.getLogger("litellm").setLevel(logging.CRITICAL)
logging.getLogger("litellm").addHandler(logging.NullHandler())
```
