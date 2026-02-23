---
name: development
description: I will refer to this when I receive development instructions.
---

## Development

### Development Tools
- **uv**: Dependency management and virtual environments
- **ruff**: Code formatting and linting
- **pytest**: Unit and integration testing
- **ty**: Type checker

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
uv run ty check .
```

### Testing

Run all tests:
```bash
uv run pytest
```
