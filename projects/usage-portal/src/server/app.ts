import { Hono } from "hono";
import type { HealthReport } from "./health";

export type AppDeps = {
  health: () => HealthReport;
};

export function createApp(deps: AppDeps) {
  const app = new Hono();

  return app.get("/api/health", (c) => {
    const report = deps.health();
    c.header("Cache-Control", "no-store");

    return report.ok ? c.json(report, 200) : c.json(report, 503);
  });
}

export type AppType = ReturnType<typeof createApp>;
