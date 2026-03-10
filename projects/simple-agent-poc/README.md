# simple-agent-poc

## Setup

1. Install dependencies:

```bash
uv sync
```

2. Copy the environment file:
```bash
cp .env.example .env
```

3. Edit `.env` and set your API credentials:
```bash
OPENAI_API_KEY="your-api-key"
OPENAI_BASE_URL="your-base-url"
```

## Usage

```bash
uv run dev
```

## API Usage

Start the HTTP API:

```bash
uv run api
```

Send a request:

```bash
curl -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

Continue the same conversation by sending back the returned `session_id`:

```bash
curl -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Continue","session_id":"<session-id>"}'
```

## Architecture Direction

`simple-agent-poc` keeps the CLI as the primary development entrypoint, but the architecture is
now defined as a multi-entry application so the same agent flow can later be reused from HTTP and
other adapters.

- `core`: conversation session model, message types, and domain errors
- `application`: use cases, DTOs, and ports such as `SessionStore` and `LLMClient`
- `adapters`: CLI, HTTP, LiteLLM, and in-memory session storage
- `entrypoints`: thin startup modules that wire dependencies

The current boundary policy and migration direction are documented in
`.claude/skills/architecture/SKILL.md`.

The reusable execution contract now lives under `src/simple_agent_poc/application/`.
The session model lives under `src/simple_agent_poc/core/`.
The CLI and HTTP adapters live under `src/simple_agent_poc/adapters/`.
The process entrypoints live under `src/simple_agent_poc/entrypoints/`.

## Session Model

- CLI keeps one in-process conversation and forwards the active `session_id` internally.
- HTTP accepts an optional `session_id` and returns the effective `session_id` on every response.
- The initial implementation uses an in-memory `SessionStore`; durable persistence is a later step.

## Development

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
uv run ty check .
```

Run tests:
```bash
uv run pytest
```

Run tests with coverage:
```bash
uv run pytest --cov=simple_agent_poc --cov-report=term-missing
```

Generate HTML coverage report:
```bash
uv run pytest --cov=simple_agent_poc --cov-report=html
# Open htmlcov/index.html to view the report
```
