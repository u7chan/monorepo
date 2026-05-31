import { loadPyodide } from "pyodide";

const TIMEOUT_MS = 1000;
const WORKER_GRACE_MS = 5000;

const environment = {
  bun: Bun.version,
  pyodide: "0.29.4",
  platform: process.platform,
  arch: process.arch,
};

const workerUrl = new URL("./pyodide-worker.mjs", import.meta.url);

async function main() {
  const inProcess = await runInProcessChecks();
  const workerExecution = await runInFreshWorker({
    input: { values: [1, 2, 3] },
    timeoutMs: TIMEOUT_MS,
    code: `
import json
import sys

sandbox_input = json.loads(sandbox_input_json)
print("received", len(sandbox_input["values"]))
print("warning", file=sys.stderr)
json.dumps({"sum": sum(sandbox_input["values"])})
`,
  });
  const timeout = await runInFreshWorker({
    input: null,
    timeoutMs: TIMEOUT_MS,
    code: `
while True:
    pass
`,
  });
  const freshWorkerState = await verifyFreshWorkerState();

  console.log(
    JSON.stringify(
      {
        environment,
        limitsCompared: {
          timeoutDefaultMs: 1000,
          timeoutMaxMs: 3000,
          inputSizeMaxBytes: 1024 * 1024,
          outputSizeMaxBytes: 64 * 1024,
          network: "disabled by policy, not by Pyodide primitive",
          hostFilesystem: "disabled only when running in an isolated worker without host FS bridges",
          stateSharingAcrossRequests: "requires fresh worker/interpreter or explicit reset",
        },
        inProcess,
        workerExecution,
        timeout,
        freshWorkerState,
        decision: {
          phase2: "proceed_with_constraints",
          constraints: [
            "Run Python/Pyodide in a dedicated worker so SharedArrayBuffer interrupts can stop CPU loops.",
            "Terminate or replace the worker after each request unless a tested reset layer is added.",
            "Expose only an import allowlist; Pyodide does not provide this contract directly.",
            "Treat Pyodide as a resource isolation aid, not as a full security boundary.",
          ],
        },
      },
      null,
      2,
    ),
  );
}

async function runInProcessChecks() {
  const startedAt = performance.now();
  const pyodide = await loadPyodide();
  const initializedMs = Math.round(performance.now() - startedAt);
  const stdout = [];
  const stderr = [];

  pyodide.setStdin({ error: true });
  pyodide.setStdout({ batched: (text) => stdout.push(`${text}\n`) });
  pyodide.setStderr({ batched: (text) => stderr.push(`${text}\n`) });

  const executionStartedAt = performance.now();
  const resultJson = await pyodide.runPythonAsync(`
import json
import sys

print("hello from pyodide")
print("stderr from pyodide", file=sys.stderr)
leaked_global = "still here"
with open("/tmp/pyodide-spike-leak.txt", "w") as handle:
    handle.write("leak")
json.dumps({"ok": True, "value": 6})
`);

  const leaks = await pyodide.runPythonAsync(`
import json
import os

json.dumps({
    "globalLeaked": "leaked_global" in globals(),
    "tmpFileLeaked": os.path.exists("/tmp/pyodide-spike-leak.txt"),
    "mathImportAllowedByDefault": __import__("math").sqrt(9) == 3,
})
`);

  return {
    initializedMs,
    executionMs: Math.round(performance.now() - executionStartedAt),
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    result: JSON.parse(resultJson),
    leaksWithoutReset: JSON.parse(leaks),
  };
}

async function runInFreshWorker({ code, input, timeoutMs }) {
  const worker = new Worker(workerUrl, { type: "module" });
  const interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
  let timeoutId;
  let hardKillId;

  const result = await new Promise((resolve) => {
    const hardKill = () => {
      worker.terminate();
      resolve({
        status: "error",
        timeoutMs,
        error: {
          name: "WorkerTimeout",
          message: "worker did not stop after interrupt grace period",
        },
      });
    };

    hardKillId = setTimeout(hardKill, timeoutMs + WORKER_GRACE_MS + 10_000);

    worker.onmessage = (event) => {
      if (event.data.type === "ready") {
        timeoutId = setTimeout(() => {
          interruptBuffer[0] = 2;
        }, timeoutMs);
        clearTimeout(hardKillId);
        hardKillId = setTimeout(hardKill, timeoutMs + WORKER_GRACE_MS);
        worker.postMessage({ code, input, interruptBuffer });
        return;
      }

      resolve(event.data);
    };
    worker.onerror = (error) =>
      resolve({
        status: "error",
        error: {
          name: "WorkerError",
          message: error.message,
        },
      });
  });

  clearTimeout(timeoutId);
  clearTimeout(hardKillId);
  worker.terminate();
  return result;
}

async function verifyFreshWorkerState() {
  const first = await runInFreshWorker({
    input: null,
    timeoutMs: TIMEOUT_MS,
    code: `
import json

leaked_global = "first request"
with open("/tmp/pyodide-worker-leak.txt", "w") as handle:
    handle.write("leak")
json.dumps({"created": True})
`,
  });
  const second = await runInFreshWorker({
    input: null,
    timeoutMs: TIMEOUT_MS,
    code: `
import json
import os

json.dumps({
    "globalLeaked": "leaked_global" in globals(),
    "tmpFileLeaked": os.path.exists("/tmp/pyodide-worker-leak.txt"),
})
`,
  });

  return {
    first,
    second,
    isolated: second.status === "success" && JSON.parse(second.result).globalLeaked === false,
  };
}

await main();
