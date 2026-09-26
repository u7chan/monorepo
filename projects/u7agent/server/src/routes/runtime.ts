import type { Context } from "hono";
import type { PiBff } from "../agent";
import { messageFor } from "../http";
import { SandboxRuntimeError, type SandboxRuntimeDiagnostics } from "../sandbox/client";
import { SandboxRuntimeInfoSchema } from "../schema";

export const RUNTIME_MODELS_UNAVAILABLE_MESSAGE = "ランタイムのモデル情報を取得できません";

export function createRuntimeRoutes({
  pi,
  runtimeDiagnostics,
}: {
  pi: PiBff | null;
  /** 実行環境の診断 (未設定なら not_configured)。workspace クライアントとは別に注入する */
  runtimeDiagnostics: SandboxRuntimeDiagnostics | null;
}) {
  return {
    models: (c: Context) => {
      const diagnostics = pi?.runtimeDiagnostics;
      if (!diagnostics || diagnostics.summary.status !== "available") {
        return c.json({ error: RUNTIME_MODELS_UNAVAILABLE_MESSAGE }, 503);
      }
      return c.json(diagnostics.catalog);
    },
    /**
     * 実行環境の診断。未接続を含めて常に 200 で返し、UI は state だけで分岐する。
     * URL / トークン / サンドボックスの内部エラーはクライアントへ出さず、詳細はログに限る。
     */
    environment: async (c: Context) => {
      if (!runtimeDiagnostics) return c.json({ state: "not_configured" } as const);
      try {
        const parsed = SandboxRuntimeInfoSchema.safeParse(await runtimeDiagnostics.getRuntimeInfo());
        if (!parsed.success) {
          console.warn(`[u7agent] sandbox runtime info is invalid: ${parsed.error.message}`);
          return c.json({ state: "probe_failed" } as const);
        }
        return c.json({
          state: "connected" as const,
          environment: parsed.data.environment,
          commands: parsed.data.commands,
        });
      } catch (error) {
        const failure = error instanceof SandboxRuntimeError ? error.failure : "probe_failed";
        console.warn(`[u7agent] sandbox runtime probe failed (${failure}): ${messageFor(error)}`);
        return c.json({ state: failure } as const);
      }
    },
  };
}
