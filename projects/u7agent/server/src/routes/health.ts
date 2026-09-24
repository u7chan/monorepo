import { resolve } from "node:path";
import type { Context } from "hono";
import { AUTH_REQUIRED_MESSAGE, unavailableRuntimeDiagnostics } from "../agent";
import type { PiBff } from "../agent";
import { resolveArchiveExcludeNames } from "../archive-rules";
import type { AppDbStatus } from "../app-db";

function modelLabel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
}

export interface SessionStoreHealth {
  status(): { path: string | null; ok: boolean; error?: string; dirty: number };
}

export interface AppDbHealth {
  status(): AppDbStatus;
}

/** health へ出す実効値の取得元（設定ストア）。省略時は既定を使う */
export interface ArchiveSettingsHealth {
  effectiveNames(): string[];
}

export function createHealthRoutes({
  pi,
  initError,
  cwd,
  store,
  appDb,
  archiveSettings,
}: {
  pi: PiBff | null;
  initError: string | undefined;
  cwd: string;
  store?: SessionStoreHealth;
  appDb?: AppDbHealth;
  archiveSettings?: ArchiveSettingsHealth;
}) {
  return {
    health: (c: Context) => {
      // ready は「runtime が使え、利用可能モデルが 1 つ以上ある」の意で、
      // 明示 PI_MODEL が使えるかどうかとは分離する (defaultModelError)。
      const availableModels = pi?.availableModels ?? [];
      const ready = Boolean(pi) && availableModels.length > 0;
      // PI_MODELS が候補を全部落としたなら、認証の有無より先に whitelist 側を原因として示す。
      const whitelistEmpty = Boolean(pi && pi.modelWhitelistExcludesAll);
      const authRequired = Boolean(pi && !ready && !whitelistEmpty && pi.availabilityError === AUTH_REQUIRED_MESSAGE);
      const errorCode: "authentication_required" | "model_whitelist_empty" | "runtime_unavailable" | undefined =
        whitelistEmpty
          ? "model_whitelist_empty"
          : authRequired
            ? "authentication_required"
            : initError || (pi && !ready)
              ? "runtime_unavailable"
              : undefined;
      const sessionStore = store?.status();
      const appDbStatus = appDb?.status();
      return c.json({
        ok: true,
        ready,
        cwd: pi?.cwd || resolve(cwd),
        model: modelLabel(pi?.selectedModel),
        availableModels: availableModels.map(modelLabel).filter((m): m is string => m != null),
        modelOptions: pi?.modelOptions ?? [],
        defaultThinkingLevel: pi?.defaultThinkingLevel ?? "medium",
        defaultModelError: pi?.defaultModelError,
        tools: pi?.tools || [],
        availabilityError: pi?.availabilityError,
        sandboxConfigured: pi?.sandboxConfigured ?? false,
        runtimeDiagnostics:
          pi?.runtimeDiagnostics?.summary ??
          unavailableRuntimeDiagnostics(pi ? "diagnostics_unavailable" : "runtime_unavailable"),
        // クライアントは行にダウンロードを出すかの判定に使う。設定ストアの実効値が正で、download / check も同じ値を使う
        archive: { excludeNames: archiveSettings?.effectiveNames() ?? resolveArchiveExcludeNames() },
        ...(sessionStore ? { sessionStore } : {}),
        ...(appDbStatus ? { appDb: appDbStatus } : {}),
        errorCode,
        error: initError ?? (authRequired ? AUTH_REQUIRED_MESSAGE : pi?.availabilityError),
      });
    },
  };
}
