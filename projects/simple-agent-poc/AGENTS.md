# AGENTS.md

## Tech Stack

| Category | Tool | Purpose |
| :--- | :--- | :--- |
| **Core** | Python 3.14-slim | Lightweight Docker image |
| **Package Manager** | uv | Fast package manager & virtual environments |
| **Code Quality** | ruff | Linter & formatter |
| **Testing** | pytest | Testing framework |
| **Type Checking** | ty | Static type checking |
| **LLM Integration** | LiteLLM | LLM provider integration |
| **Environment** | python-dotenv | Environment variable management |

## Architecture

`simple-agent-poc` keeps the CLI as the primary development entrypoint, but the application is
structured so the same agent flow can also be called from HTTP.

- `core`
  - Conversation session model, message types, and domain/application-facing errors
- `application`
  - Reusable use case, DTOs, and ports such as `LLMClient` and `SessionStore`
- `adapters`
  - CLI and HTTP transport adapters, LiteLLM integration, and session-store implementations
- `entrypoints`
  - Thin startup modules that compose production dependencies for CLI and API

## Boundary Rules

- Keep CLI rendering and stdin/stdout handling out of `core` and `application`
- Keep FastAPI request/response models and HTTP status mapping out of `core` and `application`
- Put reusable agent execution flow in `application/use_cases.py`
- Keep session persistence behind `application.ports.SessionStore`
- Keep production wiring in `entrypoints/bootstrap.py`

## Project Structure

```text
src/simple_agent_poc/
  core/
  application/
  adapters/
    cli/
    http/
    llm/
    session_store/
  entrypoints/
```

## Entrypoints

- CLI: `uv run dev`
- HTTP API: `uv run api`

HTTP API starts on `127.0.0.1:8000` and exposes `POST /api/chat`.

## Session Model

- CLI keeps the current `session_id` in-process and reuses it across turns
- HTTP accepts an optional `session_id` and returns the active `session_id` on every response
- The default implementation uses an in-memory session store

## Development

Install dependencies:

```bash
uv sync
```

Format code:

```bash
uv run ruff format .
```

Lint code:

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
