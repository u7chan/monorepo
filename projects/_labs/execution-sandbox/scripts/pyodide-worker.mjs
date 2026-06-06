import { loadPyodide } from "pyodide";

const startedAt = performance.now();
let initializedMs = 0;

const pyodide = await loadPyodide().then(
  (loadedPyodide) => {
    loadedPyodide.setStdin({ error: true });
    initializedMs = Math.round(performance.now() - startedAt);
    globalThis.postMessage({ type: "ready", initializedMs });
    return loadedPyodide;
  },
  (error) => {
    globalThis.postMessage({
      type: "init-error",
      status: "error",
      error: normalizeError(error),
    });
    globalThis.onmessage = null;
    return null;
  },
);

if (pyodide) {
  globalThis.onmessage = (event) => {
    const { code, input, interruptBuffer } = event.data;
    const executionStartedAt = performance.now();
    const stdout = [];
    const stderr = [];

    try {
      pyodide.setInterruptBuffer(interruptBuffer);

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
        error: normalizeError(error),
      });
    }
  };
}

function normalizeError(error) {
  const message = error?.message ?? String(error);
  const normalized = {
    name: error?.name ?? "Error",
    message,
  };

  if (normalized.name === "PythonError") {
    normalized.pythonException = extractPythonException(message);
  }

  return normalized;
}

function extractPythonException(message) {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}
