import { describe, expect, test } from "bun:test";
import { LIMITS, type ExecuteResponse } from "../src/sandbox";
import { createExecutionApp } from "../src/server";

const javascriptHeaders = {
  "content-type": "application/json",
};

describe("execution sandbox spike", () => {
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

  test("validates timeoutMs and payload size", async () => {
    const { app } = createExecutionApp();
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

async function waitUntil(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
}
