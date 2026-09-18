import { resolve } from "node:path";
import type { Context } from "hono";
import { AUTH_REQUIRED_MESSAGE } from "../agent";
import type { PiBff } from "../agent";

function modelLabel(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
}

export interface SessionStoreHealth {
  status(): { path: string | null; ok: boolean; error?: string; dirty: number };
}

export function createHealthRoutes({
  pi,
  initError,
  cwd,
  store,
}: {
  pi: PiBff | null;
  initError: string | undefined;
  cwd: string;
  store?: SessionStoreHealth;
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
        ...(sessionStore ? { sessionStore } : {}),
        errorCode,
        error: initError ?? (authRequired ? AUTH_REQUIRED_MESSAGE : pi?.availabilityError),
      });
    },
  };
}
