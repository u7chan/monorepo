# Simple Agent POC - Specification

## Architecture

Layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────┐
│  main.py           (Application)    │
│  - CLI loop, wiring                 │
├─────────────────────────────────────┤
│  renderer.py       (UI Layer)       │
│  - Screen output (print)            │
│  - Input handling                   │
├─────────────────────────────────────┤
│  agent.py          (Business Logic) │
│  - Conversation management          │
│  - LLM interaction orchestration    │
├─────────────────────────────────────┤
│  llm_client.py     (Infrastructure) │
│  - LiteLLMClient implementation     │
├─────────────────────────────────────┤
│  interfaces.py     (Contracts)      │
│  - LLMClient Protocol               │
│  types.py          (Data Types)     │
│  - TypedDict definitions            │
└─────────────────────────────────────┘
```

## Key Rules

1. **UI Layer Only**: All `print()` calls must be in `renderer.py`
2. **No Print in Business Logic**: `agent.py` never prints; returns data only
3. **Protocol-Based**: `LLMClient` is a Protocol for easy mocking/testing

## Types

```python
Message: {role: "user" | "assistant", content: str}
LLMResponse: {content: str, usage: {prompt_tokens, completion_tokens, total_tokens}}
```

## Agent

- Maintains conversation history (`list[Message]`)
- Default model: `gpt-4.1-nano`
- Injectable LLMClient for testing

## Development

```bash
uv run ruff format .
uv run ruff check .
```
