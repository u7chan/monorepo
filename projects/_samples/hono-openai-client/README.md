# hono-openai-client

## Quick Start

Fake-mode:

```sh
API_KEY="DUMMY" \
BASE_URL="http://localhost:3000/api" \
MODEL="fake-chat" \
bun run dev
```

OpenAI:

```sh
API_KEY="<YOUR_OPENAI_API_KEY>" \
BASE_URL="https://api.openai.com/v1" \
MODEL="gpt-4o-mini" \
bun run dev
```

Gemini:

```sh
API_KEY="<YOUR_GEMINI_API_KEY>" \
BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai" \
MODEL="gemini-2.0-flash" \
bun run dev
```

DeepSeek:

```sh
API_KEY="<YOUR_DEEPSEEK_API_KEY>" \
BASE_URL="https://api.deepseek.com" \
MODEL="deepseek-chat" \
bun run dev
```

[http://localhost:3000](http://localhost:3000)
