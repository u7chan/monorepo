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

## Development

Format code:
```bash
uv run ruff format .
```

Check code:
```bash
uv run ruff check .
```
