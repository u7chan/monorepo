---
name: testing
description: I will refer to this when I receive testing instructions.
---

## Testing

### Unit Tests
- Located in `tests/` directory
- Use `pytest` framework
- Mock external dependencies (e.g., LiteLLM client)

Command:
```bash
uv run pytest
```

### E2E Tests
- The agent itself should debug using Bash.
- Bash Command: `uv run dev`
- Verify CLI interactions and LLM responses
