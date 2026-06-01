# Execution Worker

Phase 1 JavaScript worker for the AI Agent Execution Sandbox.

This service executes short JavaScript snippets through `POST /execute` with a fresh
QuickJS Runtime and Context per request. It intentionally exposes only JavaScript in
Phase 1; Python/Pyodide, queues, streaming output, runtime pooling, and `app-api`
integration are tracked as follow-up work.

## Local commands

```bash
bun install
bun test
bun run typecheck
bun run spike:pyodide
bun run dev
```

The dev server listens on `PORT` or `3000` by default.

## Docker and compose

Build the CI test stage:

```bash
docker build --target test -t execution-worker:test .
```

Build the runtime image:

```bash
docker build --target final -t execution-worker:local .
```

Start the worker with compose:

```bash
docker compose up --build execution-worker
```

The compose service exposes the worker on `EXECUTION_WORKER_PORT` or `3000` by
default. It includes a container healthcheck for `GET /healthz`.

Verify health:

```bash
curl http://localhost:3000/healthz
```

Run a smoke execution request:

```bash
curl -s http://localhost:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "language": "javascript",
    "code": "async function main(input) { console.log(\"run\"); return input.values.reduce((a, b) => a + b, 0); }",
    "input": { "values": [1, 2, 3] }
  }'
```

Phase 1 compose intentionally starts only `execution-worker`; Redis, queue/retry,
worker scale-out, and runtime pooling are not included.

## Endpoints

### `GET /healthz`

Returns service readiness metadata.

```json
{
  "status": "ok",
  "service": "execution-worker"
}
```

### `POST /execute`

Runs an `async function main(input)` in a disposable QuickJS context.

```json
{
  "language": "javascript",
  "code": "async function main(input) { console.log('run'); return input.values.reduce((a, b) => a + b, 0); }",
  "input": {
    "values": [1, 2, 3]
  },
  "timeoutMs": 5000
}
```

Success responses use HTTP 200.

```json
{
  "status": "success",
  "stdout": "run\n",
  "stderr": "",
  "result": 6,
  "durationMs": 42,
  "appliedTimeoutMs": 3000
}
```

Execution errors also use HTTP 200 and include a stable error code. Validation,
payload, and concurrency errors use HTTP 400, 413, and 429 respectively.

```json
{
  "status": "error",
  "stdout": "",
  "stderr": "",
  "result": null,
  "durationMs": 50,
  "appliedTimeoutMs": 50,
  "error": {
    "code": "TIMEOUT",
    "message": "Execution timed out"
  }
}
```

## Limits

```text
timeout default: 1000ms
timeout max: 3000ms
code size max: 32KB
input size max: 1MB
stdout + stderr combined max: 64KB
MAX_CONCURRENCY: 2
network: disabled by omission
host filesystem access: disabled by omission
subprocess: disabled by omission
thread/background execution from sandbox: disabled by omission
```

The JavaScript runtime selection notes live in `docs/runtime-selection.md`.
The Python/Pyodide Phase 2 investigation lives in
`docs/pyodide-runtime-investigation.md`.
