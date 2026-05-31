import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

export const LIMITS = {
  timeoutDefaultMs: 1000,
  timeoutMaxMs: 3000,
  codeSizeMaxBytes: 32 * 1024,
  inputSizeMaxBytes: 1024 * 1024,
  outputSizeMaxBytes: 64 * 1024,
  maxConcurrency: 2,
} as const;

export type ExecuteRequest = {
  language: "javascript";
  code: string;
  input?: unknown;
  timeoutMs?: number;
};

export type ExecuteSuccessResponse = {
  status: "success";
  stdout: string;
  stderr: string;
  result: unknown;
  durationMs: number;
  appliedTimeoutMs: number;
};

export type ExecuteErrorResponse = {
  status: "error";
  stdout?: string;
  stderr?: string;
  result?: null;
  durationMs?: number;
  appliedTimeoutMs?: number;
  error: {
    code:
      | "VALIDATION_ERROR"
      | "PAYLOAD_TOO_LARGE"
      | "CONCURRENCY_LIMIT_EXCEEDED"
      | "TIMEOUT"
      | "OUTPUT_LIMIT_EXCEEDED"
      | "RESULT_SERIALIZATION_ERROR"
      | "MAIN_FUNCTION_NOT_FOUND"
      | "EXECUTION_ERROR";
    message: string;
    details?: string[];
    limit?: number;
  };
};

export type ExecuteResponse = ExecuteSuccessResponse | ExecuteErrorResponse;

export type ExecuteHttpResult = {
  httpStatus: 200 | 400 | 413 | 429;
  body: ExecuteResponse;
};

type ValidationResult =
  | { ok: true; request: ExecuteRequest; appliedTimeoutMs: number }
  | { ok: false; result: ExecuteHttpResult };

class OutputCapture {
  stdout = "";
  stderr = "";
  private usedBytes = 0;
  private limitExceeded = false;
  private readonly encoder = new TextEncoder();

  constructor(private readonly maxBytes: number) {}

  write(stream: "stdout" | "stderr", values: unknown[]) {
    const line = `${values.map(formatConsoleValue).join(" ")}\n`;
    const bytes = this.encoder.encode(line).byteLength;
    if (this.usedBytes + bytes > this.maxBytes) {
      this.limitExceeded = true;
      throw new Error("Output limit exceeded");
    }
    this.usedBytes += bytes;
    if (stream === "stdout") {
      this.stdout += line;
    } else {
      this.stderr += line;
    }
  }

  isLimitExceeded() {
    return this.limitExceeded;
  }
}

export class ConcurrencyLimiter {
  private active = 0;

  constructor(readonly limit = LIMITS.maxConcurrency) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) {
      return null;
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
    };
  }

  getActive() {
    return this.active;
  }
}

export function validateExecuteRequest(payload: unknown): ValidationResult {
  const details: string[] = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return validationError(["request body must be a JSON object"]);
  }

  const data = payload as Record<string, unknown>;
  if (data.language !== "javascript") {
    details.push('language must be "javascript"');
  }
  if (typeof data.code !== "string") {
    details.push("code must be a string");
  }

  if (data.timeoutMs !== undefined) {
    if (
      typeof data.timeoutMs !== "number" ||
      !Number.isFinite(data.timeoutMs) ||
      data.timeoutMs <= 0
    ) {
      details.push("timeoutMs must be a positive number");
    }
  }

  if (details.length > 0) {
    return validationError(details);
  }

  const code = data.code as string;
  const input = data.input ?? null;
  const codeBytes = new TextEncoder().encode(code).byteLength;
  const inputBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (codeBytes > LIMITS.codeSizeMaxBytes || inputBytes > LIMITS.inputSizeMaxBytes) {
    return {
      ok: false,
      result: {
        httpStatus: 413,
        body: {
          status: "error",
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "code or input exceeds the configured size limit",
          },
        },
      },
    };
  }

  const requestedTimeout = data.timeoutMs ?? LIMITS.timeoutDefaultMs;
  const appliedTimeoutMs = Math.min(requestedTimeout as number, LIMITS.timeoutMaxMs);

  return {
    ok: true,
    request: {
      language: "javascript",
      code,
      input,
      timeoutMs: data.timeoutMs as number | undefined,
    },
    appliedTimeoutMs,
  };
}

export async function executeJavaScript(
  request: ExecuteRequest,
  appliedTimeoutMs = clampTimeout(request.timeoutMs),
): Promise<ExecuteHttpResult> {
  const startedAt = performance.now();
  const output = new OutputCapture(LIMITS.outputSizeMaxBytes);
  const deadline = Date.now() + appliedTimeoutMs;
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const context = runtime.newContext();
  let executionHandle: QuickJSHandle | undefined;
  let resolvedHandle: QuickJSHandle | undefined;
  let jsonHandle: QuickJSHandle | undefined;

  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadlineInterrupt = shouldInterruptAfterDeadline(deadline);
  runtime.setInterruptHandler((rt) => output.isLimitExceeded() || deadlineInterrupt(rt));

  try {
    installConsole(context, output);

    context
      .unwrapResult(
        context.evalCode(
          `globalThis.__sandboxInput = ${JSON.stringify(request.input ?? null)}; undefined;`,
          "sandbox-input.js",
        ),
      )
      .dispose();

    context.unwrapResult(context.evalCode(request.code, "user-code.js")).dispose();

    const mainType = context.unwrapResult(context.evalCode("typeof main", "main-check.js"));
    const hasMain = context.getString(mainType) === "function";
    mainType.dispose();
    if (!hasMain) {
      return executionError("MAIN_FUNCTION_NOT_FOUND", "async function main(input) is required", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }

    executionHandle = context.unwrapResult(
      context.evalCode("main(globalThis.__sandboxInput)", "main-call.js"),
    );
    const resolved = await resolveGuestPromise(context, runtime, executionHandle, appliedTimeoutMs);
    if (resolved === "timeout") {
      return executionError("TIMEOUT", "Execution timed out", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }

    resolvedHandle = context.unwrapResult(resolved);
    if (output.isLimitExceeded()) {
      return executionError("OUTPUT_LIMIT_EXCEEDED", "stdout + stderr exceeded 64KB", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }

    context.setProp(context.global, "__sandboxResult", resolvedHandle);
    const serialized = context.evalCode(
      "JSON.stringify(globalThis.__sandboxResult)",
      "result-serialization.js",
    );
    if (serialized.error) {
      serialized.error.dispose();
      return executionError("RESULT_SERIALIZATION_ERROR", "Result is not JSON serializable", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }

    jsonHandle = serialized.value;
    if (context.typeof(jsonHandle) === "undefined") {
      return executionError("RESULT_SERIALIZATION_ERROR", "Result is not JSON serializable", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }

    const result = JSON.parse(context.getString(jsonHandle));
    return {
      httpStatus: 200,
      body: {
        status: "success",
        stdout: output.stdout,
        stderr: output.stderr,
        result,
        durationMs: elapsed(startedAt),
        appliedTimeoutMs,
      },
    };
  } catch (error) {
    if (output.isLimitExceeded()) {
      return executionError("OUTPUT_LIMIT_EXCEEDED", "stdout + stderr exceeded 64KB", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }
    if (isInterruptedError(error)) {
      return executionError("TIMEOUT", "Execution timed out", {
        output,
        startedAt,
        appliedTimeoutMs,
      });
    }
    return executionError("EXECUTION_ERROR", toErrorMessage(error), {
      output,
      startedAt,
      appliedTimeoutMs,
    });
  } finally {
    jsonHandle?.dispose();
    resolvedHandle?.dispose();
    executionHandle?.dispose();
    context.dispose();
    runtime.dispose();
  }
}

function installConsole(context: QuickJSContext, output: OutputCapture) {
  const consoleHandle = context.newObject();
  const logHandle = context.newFunction("log", (...args) => {
    output.write("stdout", args.map((arg) => context.dump(arg)));
  });
  const errorHandle = context.newFunction("error", (...args) => {
    output.write("stderr", args.map((arg) => context.dump(arg)));
  });
  const warnHandle = context.newFunction("warn", (...args) => {
    output.write("stderr", args.map((arg) => context.dump(arg)));
  });

  context.setProp(consoleHandle, "log", logHandle);
  context.setProp(consoleHandle, "error", errorHandle);
  context.setProp(consoleHandle, "warn", warnHandle);
  context.setProp(context.global, "console", consoleHandle);

  warnHandle.dispose();
  errorHandle.dispose();
  logHandle.dispose();
  consoleHandle.dispose();
}

async function resolveGuestPromise(
  context: QuickJSContext,
  runtime: { executePendingJobs: () => unknown },
  handle: QuickJSHandle,
  appliedTimeoutMs: number,
) {
  const resolvedPromise = context.resolvePromise(handle);
  runtime.executePendingJobs();
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), appliedTimeoutMs),
  );
  return Promise.race([resolvedPromise, timeout]);
}

function validationError(details: string[]): ValidationResult {
  return {
    ok: false,
    result: {
      httpStatus: 400,
      body: {
        status: "error",
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details,
        },
      },
    },
  };
}

function executionError(
  code: ExecuteErrorResponse["error"]["code"],
  message: string,
  context: {
    output: OutputCapture;
    startedAt: number;
    appliedTimeoutMs: number;
  },
): ExecuteHttpResult {
  return {
    httpStatus: 200,
    body: {
      status: "error",
      stdout: context.output.stdout,
      stderr: message,
      result: null,
      durationMs: elapsed(context.startedAt),
      appliedTimeoutMs: context.appliedTimeoutMs,
      error: { code, message },
    },
  };
}

function clampTimeout(timeoutMs: number | undefined) {
  return Math.min(timeoutMs ?? LIMITS.timeoutDefaultMs, LIMITS.timeoutMaxMs);
}

function elapsed(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function formatConsoleValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function isInterruptedError(error: unknown) {
  const message = toErrorMessage(error);
  return message.includes("interrupted") || message.includes("Execution timed out");
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
