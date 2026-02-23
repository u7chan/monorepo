---
name: architecture
description: Architecture guidance: Enforces 5-layer pattern for Python CLI apps.
---

## Architecture

Layered architecture with clear separation of concerns:

- **Application Layer**
  - `main.py` - CLI loop, wiring, dependency injection
- **UI Layer**
  - `renderer.py` - Screen output (print), input handling, error display
- **Business Logic Layer**
  - `agent.py` - Conversation management, LLM interaction orchestration
- **Infrastructure Layer**
  - `llm_client.py` - LiteLLMClient implementation, error translation
- **Contracts & Data Types**
  - `interfaces.py` - LLMClient Protocol
  - `types.py` - TypedDict definitions, custom exceptions

## Key Rules

1. **UI Layer Only**: All `print()` calls must be in `renderer.py`
2. **No Print in Business Logic**: `agent.py` never prints; returns data only
3. **Protocol-Based**: `LLMClient` is a Protocol for easy mocking/testing

## Types

```python
Message: {role: "system" | "user" | "assistant", content: str}
LLMResponse: {content: str, usage: {prompt_tokens, completion_tokens, total_tokens}}
```

## Agent

- Maintains conversation history (`list[Message]`)
- Required constructor parameters:
  - `system_prompt`: System prompt for the agent
  - `model`: Model name to use
- Optional `llm_client` for dependency injection (testing)

## Error Handling

- Custom exceptions in `types.py`: `AgentError` (base), `AuthenticationError`, `RateLimitError`, `LLMError`
- LLM errors are caught in `llm_client.py` and converted to user-friendly messages
- All errors are displayed via `renderer.show_error()`
- LiteLLM logging is suppressed in `main.py`
