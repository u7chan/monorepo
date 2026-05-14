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

## References

- Project overview and setup: `README.md`
- Default agent definitions: `agents.yaml`
- Skills index: `.claude/skills/README.md`
