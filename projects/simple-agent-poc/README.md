# simple-agent-poc

Lightweight AI agent PoC with CLI and HTTP API interfaces.

## Setup

```bash
uv sync
cp .env.example .env
# Edit .env: set OPENAI_API_KEY, OPENAI_BASE_URL
```

## Quick Start

```bash
uv run dev                 # CLI (default agent)
uv run dev --agent kansaiben
uv run api                 # HTTP API on 127.0.0.1:8000
```

## API Usage

```bash
# Synchronous chat
curl -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'

# Continue a session via Session-Id header
curl -X POST http://127.0.0.1:8000/api/chat \
  -H "Session-Id: <session-id>" \
  -H "Content-Type: application/json" \
  -d '{"message":"Continue"}'

# Streaming chat (SSE)
curl -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

## Documentation

Detailed specifications:
- [Architecture](docs/architecture.md)
- [Agent Definitions](docs/agent-definition.md)
- [Session Model](docs/session.md)
- [CLI Mode](docs/cli.md)
- [HTTP API](docs/api.md)
- [SSE Streaming](docs/sse.md)
- [LLM Integration](docs/llm-integration.md)
- [Bootstrap / DI](docs/bootstrap.md)
- [Type Reference](docs/types.md)
- [Error Handling](docs/errors.md)
- [Development Guide](docs/development.md)
- [Testing Guide](docs/testing.md)
