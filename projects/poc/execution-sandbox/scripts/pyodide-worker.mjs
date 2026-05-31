import { loadPyodide } from "pyodide";

const startedAt = performance.now();
let pyodide;
let initializedMs = 0;

try {
  pyodide = await loadPyodide();
  pyodide.setStdin({ error: true });
  initializedMs = Math.round(performance.now() - startedAt);
  globalThis.postMessage({ type: "ready", initializedMs });
} catch (error) {
  globalThis.postMessage({
    type: "init-error",
    status: "error",
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
    },
  });
}

globalThis.onmessage = async (event) => {
  const { code, input, interruptBuffer } = event.data;
  const executionStartedAt = performance.now();
  const stdout = [];
  const stderr = [];

  try {
    if (interruptBuffer) {
      pyodide.setInterruptBuffer(interruptBuffer);
    }

    pyodide.setStdout({ batched: (text) => stdout.push(`${text}\n`) });
    pyodide.setStderr({ batched: (text) => stderr.push(`${text}\n`) });
    pyodide.globals.set("sandbox_input_json", JSON.stringify(input ?? null));

    const result = pyodide.runPython(code);

    globalThis.postMessage({
      type: "result",
      status: "success",
      initializedMs,
      executionMs: Math.round(performance.now() - executionStartedAt),
      totalMs: initializedMs + Math.round(performance.now() - executionStartedAt),
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      result,
    });
  } catch (error) {
    globalThis.postMessage({
      type: "result",
      status: "error",
      initializedMs,
      executionMs: Math.round(performance.now() - executionStartedAt),
      totalMs: initializedMs + Math.round(performance.now() - executionStartedAt),
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
      },
    });
  }
};
