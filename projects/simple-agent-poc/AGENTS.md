# Simple Agent POC - Specification

## Tech Stack

### Core Technologies
- **Python**: 3.14-slim (Lightweight Docker image)
- **Package Manager**: uv (Fast Python package manager)
- **Code Quality**: ruff (Linter and formatter)
- **Testing**: pytest (Testing framework)

### Development Tools
- **uv**: Dependency management and virtual environments
- **ruff**: Code formatting and linting
- **pytest**: Unit and integration testing
- **ty**: Type checker

### Runtime Dependencies
- **LiteLLM**: LLM provider integration
- **python-dotenv**: Environment variable management
- **Standard Library**: Minimal external dependencies

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
Message: {role: "user" | "assistant", content: str}
LLMResponse: {content: str, usage: {prompt_tokens, completion_tokens, total_tokens}}
```

## Agent

- Maintains conversation history (`list[Message]`)
- Default model: `gpt-4.1-nano`
- Injectable LLMClient for testing

## Error Handling

- Custom exceptions in `types.py`: `AgentError` (base), `AuthenticationError`, `RateLimitError`, `LLMError`
- LLM errors are caught in `llm_client.py` and converted to user-friendly messages
- All errors are displayed via `renderer.show_error()`
- LiteLLM logging is suppressed in `main.py`

## Development

### Code Quality

Format code:
```bash
uv run ruff format .
```

Check code:
```bash
uv run ruff check .
```

Type check:
```bash
uvx ty check
```

### Testing

Run all tests:
```bash
uv run pytest
```

Run with coverage report:
```bash
uv run pytest --cov=simple_agent_poc --cov-report=term-missing
```

Generate HTML coverage report:
```bash
uv run pytest --cov=simple_agent_poc --cov-report=html
```

#### Test Structure

- `tests/test_types.py` - Exception classes and TypedDict definitions
- `tests/test_llm_client.py` - LLM client with mocked LiteLLM
- `tests/test_agent.py` - Agent business logic with mocked client
- `tests/test_renderer.py` - UI rendering functions
- `tests/test_interfaces.py` - Protocol definitions

#### Testing Guidelines

- **Mock external dependencies**: LiteLLM client is always mocked
- **Capture mutable arguments**: Lists passed to mocks are copied at call time
- **Test error paths**: All custom exceptions have dedicated test cases
- **UI tests use print mocking**: `builtins.print` is patched to verify output
