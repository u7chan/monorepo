import { Hono } from "hono";
import {
  ConcurrencyLimiter,
  LIMITS,
  executeJavaScript,
  validateExecuteRequest,
} from "./sandbox";

export type ExecutionAppOptions = {
  beforeExecute?: () => void | Promise<void>;
};

export function createExecutionApp(options: ExecutionAppOptions = {}) {
  const app = new Hono();
  const limiter = new ConcurrencyLimiter(LIMITS.maxConcurrency);

  app.post("/execute", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        {
          status: "error",
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request",
            details: ["request body must be valid JSON"],
          },
        },
        400,
      );
    }

    const validation = validateExecuteRequest(payload);
    if (!validation.ok) {
      return c.json(validation.result.body, validation.result.httpStatus);
    }

    const release = limiter.tryAcquire();
    if (!release) {
      return c.json(
        {
          status: "error",
          error: {
            code: "CONCURRENCY_LIMIT_EXCEEDED",
            message: "Too many concurrent executions",
            limit: LIMITS.maxConcurrency,
          },
        },
        429,
      );
    }

    try {
      await options.beforeExecute?.();
      const result = await executeJavaScript(validation.request, validation.appliedTimeoutMs);
      return c.json(result.body, result.httpStatus);
    } finally {
      release();
    }
  });

  return {
    app,
    getActiveExecutions: () => limiter.getActive(),
  };
}

const { app } = createExecutionApp();

export default {
  port: Number(Bun.env.PORT ?? 3000),
  fetch: app.fetch,
};
