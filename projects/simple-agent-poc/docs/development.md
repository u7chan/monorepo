# Development

## Tools

| Tool | Purpose |
|:---|:---|
| `uv` | Package manager, virtual environments, script runner |
| `ruff` | Code formatting and linting |
| `ty` | Static type checking |
| `pytest` | Testing framework |

## Commands

### Format

```bash
uv run ruff format .
```

Formats all Python files in the project.

### Lint

```bash
uv run ruff check .
```

Runs the ruff linter. Fix auto-fixable issues with:

```bash
uv run ruff check --fix .
```

### Type Check

```bash
uv run ty check .
```

Runs the `ty` static type checker on the entire project.

### Test

```bash
uv run pytest
```

Run all tests. See [docs/testing.md](testing.md) for details.

### Test with Coverage

```bash
uv run pytest --cov=simple_agent_poc --cov-report=term-missing
```

### HTML Coverage Report

```bash
uv run pytest --cov=simple_agent_poc --cov-report=html
# open htmlcov/index.html
```

## pyproject.toml Scripts

The project defines these entry points in `pyproject.toml`:

```toml
[project.scripts]
dev = "simple_agent_poc.entrypoints.main_cli:main"
api = "simple_agent_poc.entrypoints.main_api:main"
```

These are invoked via `uv run dev` and `uv run api`.
