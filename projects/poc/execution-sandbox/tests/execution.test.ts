import { describe, expect, test } from "bun:test";
import { LIMITS, validateExecuteRequest, type ExecuteResponse } from "../src/sandbox";
import { createExecutionApp } from "../src/server";

const javascriptHeaders = {
  "content-type": "application/json",
};

describe("execution-worker", () => {
  test("exposes a health endpoint for service readiness checks", async () => {
    const { app } = createExecutionApp();
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "execution-worker",
    });
  });

  test("executes async function main(input), captures console, and clamps timeout", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      timeoutMs: 10_000,
      input: { values: [1, 2, 3] },
      code: `
        async function main(input) {
          console.log("received", input.values.length);
          await Promise.resolve();
          return input.values.reduce((sum, value) => sum + value, 0);
        }
      `,
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("success");
    if (response.body.status !== "success") {
      throw new Error("expected success");
    }
    expect(response.body.result).toBe(6);
    expect(response.body.stdout).toBe("received 3\n");
    expect(response.body.stderr).toBe("");
    expect(response.body.appliedTimeoutMs).toBe(LIMITS.timeoutMaxMs);
  });

  test("returns HTTP 200 TIMEOUT for a synchronous infinite loop and releases the slot", async () => {
    const { app, getActiveExecutions } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      timeoutMs: 50,
      input: null,
      code: `
        async function main() {
          while (true) {}
        }
      `,
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("error");
    if (response.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(response.body.error.code).toBe("TIMEOUT");
    expect(getActiveExecutions()).toBe(0);

    const nextResponse = await postExecute(app, {
      language: "javascript",
      input: null,
      code: "async function main() { return 1; }",
    });
    expect(nextResponse.body.status).toBe("success");
  });

  test("returns OUTPUT_LIMIT_EXCEEDED when stdout and stderr exceed 64KB", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: `
        async function main() {
          console.log("x".repeat(${LIMITS.outputSizeMaxBytes + 1}));
          return "unreachable";
        }
      `,
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("error");
    if (response.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(response.body.error.code).toBe("OUTPUT_LIMIT_EXCEEDED");
  });

  test("returns RESULT_SERIALIZATION_ERROR for circular results", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: `
        async function main() {
          const value = {};
          value.self = value;
          return value;
        }
      `,
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("error");
    if (response.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(response.body.error.code).toBe("RESULT_SERIALIZATION_ERROR");
  });

  test("returns MAIN_FUNCTION_NOT_FOUND when main is missing", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: "const value = 1;",
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("error");
    if (response.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(response.body.error.code).toBe("MAIN_FUNCTION_NOT_FOUND");
  });

  test("rejects a non-async main function", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: "function main() { return 1; }",
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("error");
    if (response.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(response.body.error.code).toBe("MAIN_FUNCTION_NOT_ASYNC");
  });

  test("preserves captured stderr separately from execution errors", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: `
        async function main() {
          console.error("before failure");
          throw new Error("boom");
        }
      `,
    });

    expect(response.httpStatus).toBe(200);
    expect(response.body.status).toBe("error");
    if (response.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(response.body.error.code).toBe("EXECUTION_ERROR");
    expect(response.body.stderr).toBe("before failure\n");
    expect(response.body.error.message).toContain("boom");
  });

  test("does not leak global state between executions", async () => {
    const { app } = createExecutionApp();
    await postExecute(app, {
      language: "javascript",
      input: null,
      code: `
        async function main() {
          globalThis.leaked = "previous";
          return globalThis.leaked;
        }
      `,
    });

    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: `
        async function main() {
          return typeof globalThis.leaked;
        }
      `,
    });

    expect(response.body.status).toBe("success");
    if (response.body.status !== "success") {
      throw new Error("expected success");
    }
    expect(response.body.result).toBe("undefined");
  });

  test("does not expose Bun, Node process, filesystem, subprocess, or network APIs", async () => {
    const { app } = createExecutionApp();
    const response = await postExecute(app, {
      language: "javascript",
      input: null,
      code: `
        async function main() {
          return {
            Bun: typeof Bun,
            process: typeof process,
            require: typeof require,
            fetch: typeof fetch,
            WebSocket: typeof WebSocket
          };
        }
      `,
    });

    expect(response.body.status).toBe("success");
    if (response.body.status !== "success") {
      throw new Error("expected success");
    }
    expect(response.body.result).toEqual({
      Bun: "undefined",
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      WebSocket: "undefined",
    });
  });

  test("enforces MAX_CONCURRENCY=2 with HTTP 429 and no Retry-After header", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { app, getActiveExecutions } = createExecutionApp({
      beforeExecute: () => gate,
    });

    const request = {
      language: "javascript",
      input: null,
      code: "async function main() { return 1; }",
    };
    const first = postExecute(app, request);
    const second = postExecute(app, request);

    await waitUntil(() => getActiveExecutions() === LIMITS.maxConcurrency);

    const rejected = await postExecute(app, request);
    expect(rejected.httpStatus).toBe(429);
    expect(rejected.response.headers.has("retry-after")).toBe(false);
    expect(rejected.body.status).toBe("error");
    if (rejected.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(rejected.body.error.code).toBe("CONCURRENCY_LIMIT_EXCEEDED");

    releaseGate();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.body.status).toBe("success");
    expect(secondResult.body.status).toBe("success");
    expect(getActiveExecutions()).toBe(0);
  });

  test("validates JSON body, language, timeoutMs, and payload size", async () => {
    const { app } = createExecutionApp();
    const invalidJson = await postRaw(app, "{");
    expect(invalidJson.httpStatus).toBe(400);
    expect(invalidJson.body.status).toBe("error");
    if (invalidJson.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(invalidJson.body.error.code).toBe("VALIDATION_ERROR");

    const unsupportedLanguage = await postExecute(app, {
      language: "python",
      input: null,
      code: "async function main() { return 1; }",
    });
    expect(unsupportedLanguage.httpStatus).toBe(400);
    expect(unsupportedLanguage.body.status).toBe("error");
    if (unsupportedLanguage.body.status !== "error") {
      throw new Error("expected error");
    }
    expect(unsupportedLanguage.body.error.code).toBe("VALIDATION_ERROR");

    const invalidTimeout = await postExecute(app, {
      language: "javascript",
      timeoutMs: 0,
      input: null,
      code: "async function main() { return 1; }",
    });
    expect(invalidTimeout.httpStatus).toBe(400);

    const tooLarge = await postExecute(app, {
      language: "javascript",
      input: null,
      code: "x".repeat(LIMITS.codeSizeMaxBytes + 1),
    });
    expect(tooLarge.httpStatus).toBe(413);

    const tooLargeInput = await postExecute(app, {
      language: "javascript",
      input: "x".repeat(LIMITS.inputSizeMaxBytes + 1),
      code: "async function main(input) { return input.length; }",
    });
    expect(tooLargeInput.httpStatus).toBe(413);
  });

  test("validates non-JSON-serializable input before execution", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const circularResult = validateExecuteRequest({
      language: "javascript",
      input: circular,
      code: "async function main() { return 1; }",
    });
    expect(circularResult.ok).toBe(false);
    if (circularResult.ok) {
      throw new Error("expected validation error");
    }
    expect(circularResult.result.httpStatus).toBe(400);
    expect(circularResult.result.body.status).toBe("error");
    if (circularResult.result.body.status !== "error") {
      throw new Error("expected error body");
    }
    expect(circularResult.result.body.error.details).toContain(
      "input is not JSON serializable",
    );

    const bigintResult = validateExecuteRequest({
      language: "javascript",
      input: 1n,
      code: "async function main() { return 1; }",
    });
    expect(bigintResult.ok).toBe(false);
  });
});

async function postExecute(
  app: ReturnType<typeof createExecutionApp>["app"],
  body: unknown,
): Promise<{
  response: Response;
  httpStatus: number;
  body: ExecuteResponse;
}> {
  const response = await app.request("/execute", {
    method: "POST",
    headers: javascriptHeaders,
    body: JSON.stringify(body),
  });
  return {
    response,
    httpStatus: response.status,
    body: (await response.json()) as ExecuteResponse,
  };
}

async function postRaw(
  app: ReturnType<typeof createExecutionApp>["app"],
  body: string,
): Promise<{
  response: Response;
  httpStatus: number;
  body: ExecuteResponse;
}> {
  const response = await app.request("/execute", {
    method: "POST",
    headers: javascriptHeaders,
    body,
  });
  return {
    response,
    httpStatus: response.status,
    body: (await response.json()) as ExecuteResponse,
  };
}

async function waitUntil(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
}
