# Python/Pyodide Runtime Investigation

Issue: #1000
Parent: #986
Refs: #993, #994

## Decision

Proceed with constraints for Phase 2 investigation follow-up.

Pyodide can execute basic Python code, serialize JSON-compatible results,
capture stdout/stderr, and stop a synchronous CPU loop when execution runs in a
dedicated worker with `SharedArrayBuffer` and `pyodide.setInterruptBuffer()`.
It should not be added to production `execution-worker` until the worker
lifecycle, import allowlist, and reset strategy are implemented and tested.

## Repeatable Spike

From `projects/_labs/execution-sandbox/`:

```bash
bun install
bun run spike:pyodide
```

The spike files are:

```text
scripts/pyodide-spike.mjs
scripts/pyodide-worker.mjs
```

The command prints JSON with environment metadata, initialization timings,
execution behavior, timeout behavior, state/virtual FS isolation checks, and the
Phase 2 decision.

## Observed Environment

Observed on 2026-05-31:

```text
Bun: 1.3.10
pyodide: 0.29.4
platform: linux x64
```

## Observed Results

| Area | Result |
| --- | --- |
| In-process initialization | Passed. `loadPyodide()` took about 2.4s to 2.9s in local runs. |
| Fresh worker initialization | Passed. Worker initialization took about 2.4s to 3.6s in local runs. |
| Basic execution | Passed. Python summed `[1, 2, 3]` and returned JSON `{"sum": 6}`. |
| stdout/stderr capture | Passed. `pyodide.setStdout()` captured `received 3\n`; `pyodide.setStderr()` captured `warning\n`. |
| Timeout/cancellation | Passed for synchronous Python code when using a worker interrupt buffer. `while True: pass` produced a JS `PythonError` at about 1.0s execution time with a 1000ms timeout, and the traceback identifies the Python exception as `KeyboardInterrupt`. |
| Virtual FS reset | Passed only with a fresh worker per execution. Reusing one Pyodide instance leaks `/tmp` files unless explicitly reset. |
| Global state reset | Passed only with a fresh worker per execution. Reusing one Pyodide instance leaks Python globals unless explicitly reset. |
| Import control | Not provided as a sandbox policy by Pyodide. Built-in imports such as `math` are available by default, so a production runtime needs an explicit allowlist/enforcement layer. |

## Contract Comparison

JavaScript Phase 1 limits:

```text
timeout default: 1000ms
timeout max: 3000ms
input size max: 1MB
stdout + stderr combined max: 64KB
network: disabled
host filesystem access: disabled
state sharing across requests: disabled
```

Python/Pyodide fit:

| Contract Area | Fit | Notes |
| --- | --- | --- |
| Timeout | Medium | Pyodide supports interrupts through a shared interrupt buffer, but the runtime must run inside a worker. The timeout budget should start after runtime initialization. |
| Cancellation | Medium | Synchronous Python loops can be interrupted. JS functions called from Python or blocking handlers must cooperate by checking interrupts. |
| stdout/stderr | High | Pyodide exposes standard stream handlers. A production implementation can enforce the same 64KB combined output limit in those handlers. |
| Result serialization | High for JSON values | The spike serializes results through Python `json.dumps()`. Production should require JSON-serializable return values and normalize errors. |
| Virtual FS reset | Medium | Pyodide uses an in-memory FS by default. Fresh workers isolate it; pooled workers need explicit cleanup and tests. Do not mount `NODEFS` or native FS handles for sandboxed execution. |
| Global state reset | Medium | Fresh workers isolate globals. Pooled workers need explicit namespace reset and tests. |
| Import control | Low to medium | Pyodide does not directly provide the desired import allowlist contract. Production needs a Python import hook, AST/static screening, or a restricted execution wrapper, and still must treat this as policy enforcement rather than a full security boundary. |
| Network | Low to medium | The Python runtime should not receive JS modules or host APIs that expose network access. Any package loading must be disabled or constrained before user code runs. |

## Implementation Constraints

- Run Python/Pyodide in a dedicated worker, not on the Hono request thread.
- Start the execution timeout after Pyodide is initialized, and report
  initialization cost separately from execution duration.
- Use `SharedArrayBuffer` and `pyodide.setInterruptBuffer()` for synchronous
  Python cancellation.
- Normalize Pyodide errors before returning them. In local runs, timeout
  interruption surfaced as JS `PythonError` with Python `KeyboardInterrupt` in
  the traceback rather than as a JS `KeyboardInterrupt` name.
- Prefer fresh worker per execution for the first production spike. Pooling can
  be considered later only with reset tests for globals, `/tmp`, loaded modules,
  stream handlers, and interrupt state.
- Set stdin to an erroring handler so sandboxed code cannot block on input.
- Install stdout/stderr handlers that enforce the combined 64KB output limit.
- Do not mount `NODEFS`, `WORKERFS`, `IDBFS`, or native file system handles.
- Do not expose `fetch`, process, Bun, Node, or arbitrary JS modules to Python.
- Treat import allowlisting as unresolved implementation work.

## References

- Pyodide Node/Bun usage: https://pyodide.org/en/stable/usage/index.html#node-js
- Pyodide interrupt mechanism: https://pyodide.org/en/stable/usage/keyboard-interrupts.html
- Pyodide standard streams: https://pyodide.org/en/stable/usage/streams.html
- Pyodide file system behavior: https://pyodide.org/en/stable/usage/file-system.html
- Pyodide JavaScript API: https://pyodide.org/en/stable/usage/api/js-api.html

## Follow-up Implementation Issue Draft

Title: `[execution-sandbox] Add constrained Python/Pyodide worker spike`

Parent: #986
Refs: #1000

Objective:

Implement a non-production Python runtime path behind the execution-worker
contract to validate request/response shape, worker lifecycle, cancellation, and
reset behavior with API-level tests.

Scope:

- Add `language: "python"` behind an experimental flag or spike-only route.
- Run Pyodide in a dedicated worker.
- Measure and return initialization and execution duration separately.
- Enforce timeout default 1000ms and max 3000ms after initialization.
- Capture stdout/stderr with the same 64KB combined output limit.
- Serialize JSON-compatible results.
- Terminate or replace the worker after each request.
- Reject stdin reads.
- Keep network, host filesystem, subprocess, package installation, and host JS
  APIs unavailable.
- Add tests for timeout, stdout/stderr, result serialization, globals reset,
  virtual FS reset, and import policy behavior.

Acceptance criteria:

- Python execution returns the same success/error envelope shape as JavaScript.
- A synchronous infinite loop returns `TIMEOUT` and the next request succeeds.
- stdout/stderr/result behavior is covered by tests.
- Globals and virtual FS files do not leak between requests.
- Import policy behavior is documented and tested for the agreed allowlist.
- The implementation is clearly marked as spike or experimental until security
  review is complete.
