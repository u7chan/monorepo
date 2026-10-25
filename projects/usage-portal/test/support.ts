import type { CodexApi } from "../src/server/codex/api";
import type { OpenCodeApi } from "../src/server/opencode/api";
import type { ProviderSnapshot } from "../src/server/providers/types";
import type { UsagePayload } from "../src/server/usage";

/** 認証だけを試すテスト用の空の利用枠。provider の取得には触れない。 */
export const EMPTY_USAGE: UsagePayload = { generatedAt: 0, sampleIntervalMs: 300_000, providers: [] };

export function stubCodexApi(overrides: Partial<CodexApi> = {}): CodexApi {
  return {
    auth: () => ({ signedIn: false, login: null }),
    startLogin: async () => {},
    respond: () => {},
    cancelLogin: () => {},
    logout: async () => {},
    ...overrides,
  };
}

export function stubOpenCodeApi(overrides: Partial<OpenCodeApi> = {}): OpenCodeApi {
  return {
    auth: () => ({ configured: false, savedAt: null }),
    save: async () => ({ ok: true, state: { configured: true, savedAt: 1_800_000_000_000 } }),
    clear: async () => {},
    ...overrides,
  };
}

export const BASE_TIME = 1_800_000_000_000;

export function usageSnapshot(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    provider: "codex",
    name: "Codex",
    plan: "Plus",
    capturedAt: BASE_TIME,
    limitReached: false,
    windows: [
      {
        id: "primary",
        label: "週次",
        durationSeconds: 604_800,
        usedPercent: 62,
        resetsAt: BASE_TIME + 3 * 24 * 60 * 60 * 1000,
      },
    ],
    notes: [],
    ...overrides,
  };
}
