# Testing

## Framework

- **pytest** — testing framework
- **pytest-cov** — coverage reporting
- **httpx** — HTTP client for API integration tests

## Test Directory

All tests live under `tests/`:

| File | Tests | Lines |
|:---|:---|:---|
| `test_agent_definition.py` | Agent definition YAML loading and validation | 261 |
| `test_api.py` | HTTP API endpoint integration tests | 262 |
| `test_application.py` | Use case tests | 272 |
| `test_cli.py` | CLI adapter tests | 216 |
| `test_http_stream_api.py` | HTTP SSE streaming tests | 151 |
| `test_interfaces.py` | Protocol interface tests | 35 |
| `test_llm_client.py` | LiteLLM client tests (largest) | 648 |
| `test_main.py` | Entry point tests | 77 |
| `test_main_api.py` | API entry point tests | 22 |
| `test_renderer.py` | CLI renderer tests | 151 |
| `test_session.py` | Session entity tests | 62 |
| `test_types.py` | Type definition tests | 87 |
| `test_use_cases_stream.py` | Streaming use case tests | 335 |

## Running Tests

```bash
# All tests
uv run pytest

# Specific test file
uv run pytest tests/test_session.py

# With verbose output
uv run pytest -v

# Match test name pattern
uv run pytest -k "stream"
```

## Coverage

```bash
# Terminal summary with missing lines
uv run pytest --cov=simple_agent_poc --cov-report=term-missing

# HTML report
uv run pytest --cov=simple_agent_poc --cov-report=html
```

HTML output goes to `htmlcov/`.

## Mocking Strategy

Tests mock external dependencies rather than making real LLM calls:
- `LLMClient` is mocked in use case and adapter tests.
- LiteLLM functions (`completion`, `responses`) are patched in `test_llm_client.py`.
- `stdin`/`stdout` are mocked in CLI tests.

## E2E / Manual Testing

For end-to-end verification against a live LLM:

```bash
uv run dev
```

Interact with the agent via the CLI. Verify response quality and streaming behavior.
