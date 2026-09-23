import type { Context } from "hono";
import type { PiBff } from "../agent";

export const RUNTIME_MODELS_UNAVAILABLE_MESSAGE = "ランタイムのモデル情報を取得できません";

export function createRuntimeRoutes({ pi }: { pi: PiBff | null }) {
  return {
    models: (c: Context) => {
      const diagnostics = pi?.runtimeDiagnostics;
      if (!diagnostics || diagnostics.summary.status !== "available") {
        return c.json({ error: RUNTIME_MODELS_UNAVAILABLE_MESSAGE }, 503);
      }
      return c.json(diagnostics.catalog);
    },
  };
}
