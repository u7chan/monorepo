import {
  findProbeModel,
  isProbeThinkingLevel,
  listProbeModels,
  supportsProbeThinking,
  type ProbeCatalog,
} from "./catalog";
import type { ProbeOutcome, ProbeRunner } from "./service";
import type { CodexProbeConfig, ProbeSettingsStore } from "./settings";

/** 設定 API の検証結果。送信時の分類 (`ProbeErrorCode`) と同じ語彙で返す。 */
export type ProbeConfigError = "invalid_model" | "invalid_thinking" | "unavailable";

export type ProbeApiResult<T> = { ok: true; value: T } | { ok: false; error: ProbeConfigError };

export type ProbeApi = {
  /** catalog は pi-ai の同梱データから作る。上流へは問い合わせない。 */
  models: () => ProbeCatalog;
  codexConfig: () => CodexProbeConfig | null;
  setCodexConfig: (input: { model: unknown; thinking: unknown }) => ProbeApiResult<CodexProbeConfig>;
  clearCodexConfig: () => ProbeApiResult<null>;
  checkCodex: () => Promise<ProbeOutcome>;
  checkOpenCode: (accountId: string) => Promise<ProbeOutcome>;
};

export function createProbeApi(options: { settings: ProbeSettingsStore; runner: ProbeRunner }): ProbeApi {
  return {
    models: () => ({ codex: listProbeModels("codex"), opencodeGo: listProbeModels("opencodeGo") }),
    codexConfig: () => options.settings.read().codex,
    setCodexConfig(input) {
      if (typeof input.model !== "string" || typeof input.thinking !== "string") {
        return { ok: false, error: "invalid_model" };
      }

      const model = findProbeModel("codex", input.model);

      if (model === null) {
        return { ok: false, error: "invalid_model" };
      }

      if (!isProbeThinkingLevel(input.thinking) || !supportsProbeThinking(model, input.thinking)) {
        return { ok: false, error: "invalid_thinking" };
      }

      const config: CodexProbeConfig = { model: input.model, thinking: input.thinking };

      try {
        options.settings.writeCodex(config);
      } catch {
        return { ok: false, error: "unavailable" };
      }

      return { ok: true, value: config };
    },
    clearCodexConfig() {
      try {
        options.settings.writeCodex(null);
      } catch {
        return { ok: false, error: "unavailable" };
      }

      return { ok: true, value: null };
    },
    checkCodex: () => options.runner.checkCodex(),
    checkOpenCode: (accountId) => options.runner.checkOpenCode(accountId),
  };
}
