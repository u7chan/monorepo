# simple-agent-poc

## Setup

1. Copy the environment file:
```bash
cp .env.example .env
```

2. Edit `.env` and set your API credentials:
```bash
OPENAI_API_KEY="your-api-key"
OPENAI_BASE_URL="your-base-url"
```

## Usage

```bash
uv run dev
```

## Architecture Direction

`simple-agent-poc` keeps the CLI as the primary development entrypoint, but the architecture is
now defined as a multi-entry application so the same agent flow can later be reused from HTTP and
other adapters.

- `core`: agent behavior and conversation rules
- `application`: reusable use cases and DTOs
- `adapters`: CLI, HTTP, and infrastructure integrations
- `entrypoints`: thin startup modules that wire dependencies

The current boundary policy and migration direction are documented in
`.claude/skills/architecture/SKILL.md`.

The reusable execution contract currently lives in [src/simple_agent_poc/application.py](src/simple_agent_poc/application.py)
as `RunAgentUseCase`, `RunAgentRequest`, and `RunAgentResponse`.

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
