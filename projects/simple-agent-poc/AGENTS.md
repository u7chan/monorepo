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
| **Config Parsing** | PyYAML | Agent definition file loading |
| **Environment** | python-dotenv | Environment variable management |
| **HTTP Framework** | FastAPI + Uvicorn | HTTP API server |
| **HTTP Testing** | httpx | HTTP client for tests |

## Task → Document Mapping

When working on a task, read the relevant document in `docs/` first.

| Task | Primary Reference | Supplementary |
| :--- | :--- | :--- |
| Understand architecture / layers / dependency direction | `docs/architecture.md` | — |
| Add or modify agent definitions (YAML) | `docs/agent-definition.md` | `agents.yaml` |
| Modify CLI mode (adapter, renderer, interaction loop) | `docs/cli.md` | `docs/sse.md` (if streaming) |
| Modify HTTP API (endpoints, request/response schema) | `docs/api.md` | `docs/sse.md` (if streaming) |
| Modify SSE streaming behavior | `docs/sse.md` | `docs/api.md`, `docs/cli.md` |
| Modify LLM integration (LiteLLM client, factory) | `docs/llm-integration.md` | `docs/types.md` |
| Modify session management (store, lifecycle) | `docs/session.md` | `docs/bootstrap.md` |
| Modify bootstrap / dependency injection / startup flow | `docs/bootstrap.md` | `docs/architecture.md` |
| Add or change type definitions | `docs/types.md` | `docs/errors.md` |
| Add or change error handling | `docs/errors.md` | `docs/types.md` |
| Run code quality checks (format, lint, type check) | `docs/development.md` | — |
| Write or modify tests | `docs/testing.md` | `docs/development.md` |

## References

- Agent definitions: `agents.yaml`
- Skills: `.claude/skills/README.md`
- Documentation index: `docs/`
