# Execution Sandbox Runtime Selection

Parent: #986
Issue: #993

## Decision

Phase 1 should use TypeScript + Bun + Hono with `quickjs-emscripten` for
JavaScript execution.

The spike gate passed on the local environment:

```text
Bun: 1.3.10
hono: 4.12.23
quickjs-emscripten: 0.32.0
```

`quickjs-emscripten` can stop a synchronous `while (true) {}` on Bun by using
the official `QuickJSRuntime#setInterruptHandler` mechanism. The HTTP spike
returns a timeout response, disposes the per-request runtime/context, and
releases the concurrency slot.

This is not a production security boundary. It is viable for the Phase 1 PoC
shape in #986: short algorithmic JavaScript, no host filesystem, no network, no
subprocess, no package install, and no long-running jobs.

## Runtime Comparison

| Runtime | Fit for Phase 1 | Notes | Decision |
| --- | --- | --- | --- |
| `quickjs-emscripten` | High | Runs JavaScript directly from TypeScript/Bun, exposes no Node/Bun APIs by default, supports per-runtime interrupt and memory/stack limits, and works with a Hono worker shape. | Adopt for Phase 1 JavaScript PoC. |
| Wasmtime | Medium for WASM, low for direct JavaScript | Strong embeddable WASM runtime, but its documented embedding path is Rust/C/C++/other native APIs. A TypeScript+Bun worker would need a binding layer and a JavaScript language runtime compiled to WASM before it can run user JS. | Do not use as first Phase 1 host runtime. Revisit for language runtimes compiled to WASM. |
| Wasmer | Medium for WASM packages, low for direct JavaScript | Wasmer has a JavaScript SDK and package ecosystem, but it is oriented around running WASM/Wasmer packages. It does not reduce the Phase 1 task of embedding a JS interpreter and shaping `async function main(input)`. | Do not use as first Phase 1 host runtime. Revisit for packaged WASM language runtimes. |

References used during selection:

- `quickjs-emscripten` README and API docs: https://github.com/justjake/quickjs-emscripten
- Wasmtime embedding docs: https://docs.wasmtime.dev/lang.html
- Wasmer JavaScript SDK docs: https://docs.wasmer.io/sdk/wasmer-js

## Spike Artifacts

```text
projects/poc/execution-sandbox/
  package.json
  src/sandbox.ts
  src/server.ts
  tests/execution.test.ts
  docs/runtime-selection.md
```

The spike keeps the future production implementation separate. `src/sandbox.ts`
contains the reusable QuickJS execution pattern, while `src/server.ts` contains
the minimal Hono `POST /execute` host.

## Execution Pattern

Phase 1 JavaScript requires:

```js
async function main(input) {
  console.log("received", input.values.length);
  return input.values.reduce((sum, value) => sum + value, 0);
}
```

The host flow is:

1. Validate `language`, `code`, `input`, and `timeoutMs`.
2. Acquire a concurrency slot.
3. Reuse the process-level QuickJS WASM module.
4. Create a fresh QuickJS runtime and context for the request.
5. Install only `console.log`, `console.error`, and `console.warn`.
6. Set the request input as a QuickJS global.
7. Evaluate user code and require `main` to be a function.
8. Require `main.constructor.name` to be `AsyncFunction`.
9. Call `main(input)`, execute QuickJS pending jobs, and await the returned promise.
10. Serialize the result with `JSON.stringify` inside QuickJS.
11. Dispose the result handles, context, and runtime.
12. Release the concurrency slot in `finally`.

## Spike Results

| Case | Result |
| --- | --- |
| Stop `while (true) {}` via interrupt handler | Passed. `QuickJSRuntime#setInterruptHandler` interrupts synchronous code and returns `TIMEOUT`. |
| HTTP E2E timeout response | Passed. `POST /execute` returns HTTP 200 with `status: "error"` and `error.code: "TIMEOUT"`. |
| Runtime/context cleanup | Passed. The test confirms the active slot count returns to 0 after timeout and a following request succeeds. |
| `async function main(input)` invocation | Passed. The test defines, calls, awaits, and serializes the returned value. |
| Non-async `main` rejection | Passed. Synchronous `function main()` returns `MAIN_FUNCTION_NOT_ASYNC`. |
| stdout/stderr capture | Passed. `console.log` maps to stdout; `console.error` and `console.warn` map to stderr. |
| stdout + stderr 64KB limit | Passed. Exceeding the combined limit returns `OUTPUT_LIMIT_EXCEEDED`. |
| Result serialization error | Passed. Circular results return `RESULT_SERIALIZATION_ERROR`. Functions and `undefined` are also treated as non-serializable. |
| Input serialization validation | Passed. Circular and `BigInt` inputs are rejected as `VALIDATION_ERROR` before execution. |
| State reset between executions | Passed. A global set by one request is absent in the next request. |
| Host API exposure | Passed. `Bun`, `process`, `require`, `fetch`, and `WebSocket` are not exposed. |
| `MAX_CONCURRENCY=2` | Passed. The third concurrent HTTP request returns 429 with no `Retry-After` header. |

The concurrency test uses a spike-only `beforeExecute` hook to hold two slots
after validation and before execution. This isolates the HTTP slot behavior from
QuickJS CPU execution and confirms the no-queue 429 policy.

## Initial Limits

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

`timeoutMs` is accepted from the request and clamped to 3000ms. The response
always includes `appliedTimeoutMs` for execution results.

## API Contract Draft

Request:

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

Success response: HTTP 200

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

Timeout response: HTTP 200

```json
{
  "status": "error",
  "stdout": "",
  "stderr": "Execution timed out",
  "result": null,
  "durationMs": 50,
  "appliedTimeoutMs": 50,
  "error": {
    "code": "TIMEOUT",
    "message": "Execution timed out"
  }
}
```

Validation error response: HTTP 400

```json
{
  "status": "error",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": ["timeoutMs must be a positive number"]
  }
}
```

Payload limit response: HTTP 413

```json
{
  "status": "error",
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "code or input exceeds the configured size limit"
  }
}
```

Concurrency limit response: HTTP 429

```json
{
  "status": "error",
  "error": {
    "code": "CONCURRENCY_LIMIT_EXCEEDED",
    "message": "Too many concurrent executions",
    "limit": 2
  }
}
```

Phase 1 does not include `Retry-After` because there is no queue.

## Verification Commands

From `projects/poc/execution-sandbox/`:

```bash
bun --version
bun test
bun run typecheck
```

Observed result:

```text
bun --version -> 1.3.10
bun test -> 10 pass, 0 fail
bun run typecheck -> passed
```

Manual HTTP check:

```bash
bun run dev
curl -s http://localhost:3000/execute \
  -H 'content-type: application/json' \
  -d '{
    "language": "javascript",
    "timeoutMs": 50,
    "input": null,
    "code": "async function main() { while (true) {} }"
  }'
```

Expected result is HTTP 200 with `error.code: "TIMEOUT"`.

## Follow-up Issue Drafts

### 1. Implement JavaScript `execution-worker`

Parent: #986

Build the production-facing JavaScript worker from the spike pattern.

Acceptance criteria:

- Create the production `execution-worker` package.
- Implement `POST /execute` with the finalized JavaScript contract.
- Keep QuickJS runtime/context per request.
- Enforce timeout, code size, input size, output size, and concurrency limits.
- Return the documented error codes and HTTP statuses.

### 2. Add sandbox lifecycle and resource tests

Parent: #986

Add focused tests around cleanup and resource boundaries.

Acceptance criteria:

- Verify timeout releases concurrency slots.
- Verify output-limit paths release concurrency slots.
- Verify runtime/context disposal after success and errors.
- Verify state reset between repeated executions.
- Verify no host APIs such as `process`, `Bun`, filesystem, subprocess, or network are exposed.

### 3. Add Docker and compose packaging for the worker

Parent: #986

Package the worker for local PoC operation.

Acceptance criteria:

- Add Dockerfile for the worker.
- Add compose service wiring for `app-api -> execution-worker`.
- Keep Redis/queue out of Phase 1.
- Document local run commands and health checks.

### 4. Investigate Python/Pyodide for Phase 2

Parent: #986

Investigate whether Pyodide can satisfy the same sandbox lifecycle contract.

Acceptance criteria:

- Measure initialization cost.
- Define virtual filesystem reset behavior.
- Verify timeout and cancellation options.
- Verify stdout/stderr/result collection.
- Compare Python limits with the JavaScript Phase 1 limits.
