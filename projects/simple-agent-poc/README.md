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

3. Edit `.env` and set your API credentials and agent definition file:
```bash
OPENAI_API_KEY="your-api-key"
OPENAI_BASE_URL="your-base-url"
AGENTS_FILE="agents.yaml"
```

## Usage

```bash
uv run dev
```

Run the CLI with a specific agent from `agents.yaml`:

```bash
uv run dev --agent kansaiben
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

Send a request with a specific agent:

```bash
curl -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"調べて","agent_id":"kansaiben"}'
```

Continue the same conversation by sending back the returned `session_id`:

```bash
curl -X POST http://127.0.0.1:8000/api/chat \
  -H "Session-Id: <session-id>" \
  -H "Content-Type: application/json" \
  -d '{"message":"Continue"}'
```

`/api/chat` uses the `Session-Id` request header as the primary session transport.
For compatibility, the JSON body still accepts an optional `session_id` for now. If both are
sent, they must match; otherwise the API returns `400`.

When continuing a session, use the same `agent_id` that created it. Changing agents for an
existing session returns `400` because the stored conversation history belongs to the original
agent definition.

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

## Agent Definitions

Agent definitions are loaded from `agents.yaml` by default. Set `AGENTS_FILE` to point at
another YAML file when running with a different definition set.

Each agent supports these fields:

- `model`: required LiteLLM model name.
- `system_prompt`: required prompt template. `{current_datetime}` is filled at session start.
- `temperature`: optional numeric generation parameter. `null` or omission means it is not sent to the LLM API.
- `tools`: optional list reserved for future tool-calling support.

Validation happens at startup for production wiring, and per request for unknown `agent_id`
values. Unknown fields, missing required fields, invalid field types, and missing `default`
agent definitions are rejected.

`tools` is currently parsed and validated but is not passed to LiteLLM yet.

Once a session is created, later requests for that `session_id` must use the same `agent_id`.

## Session Model

- CLI keeps one in-process conversation and forwards the active `session_id` internally.
- HTTP accepts `Session-Id` as the primary session transport and returns the effective `session_id` on every response.
- HTTP request-body `session_id` remains temporarily supported for compatibility, but it must match `Session-Id` when both are present.
- Each session stores the `agent_id` used at creation time, and subsequent calls must keep using it.
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
