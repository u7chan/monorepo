# execution-worker

Phase 1 JavaScript worker for the AI Agent Execution Sandbox.

## TechStack

- Bun
- TypeScript
- Hono
- quickjs-emscripten
- Docker

## Commands

```bash
# local dev
bun install
bun test
bun run typecheck
bun run dev

# docker build
docker build --target test -t execution-worker:test .
docker build --target final -t execution-worker:local .

# compose up
docker compose up --build execution-worker
```

## Smoke Test

PR作成時は必ず以下を実行し、結果をPR本文のVerificationセクションに記録すること。

```bash
# build & up
docker build --target test -t execution-worker:test .
docker build --target final -t execution-worker:local .
EXECUTION_WORKER_PORT=3100 docker compose up --build -d execution-worker

# verify
docker compose ps
curl http://localhost:3100/healthz
curl -s http://localhost:3100/execute \
  -H 'content-type: application/json' \
  -d '{
    "language": "javascript",
    "code": "async function main(input) { console.log(\"run\"); return input.values.reduce((a, b) => a + b, 0); }",
    "input": { "values": [1, 2, 3] }
  }'

# down
docker compose down
```
