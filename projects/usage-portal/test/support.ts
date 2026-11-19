import type { ClaudeRefreshMode, ClaudeRefreshResult } from "../src/server/claude/service";
import type { CodexApi } from "../src/server/codex/api";
import type { OpenCodeAccount } from "../src/server/opencode/accounts";
import type { OpenCodeApi } from "../src/server/opencode/api";
import type { ProbeApi } from "../src/server/probe/api";
import type { ProbeCatalog } from "../src/server/probe/catalog";
import type { ProviderSnapshot } from "../src/server/providers/types";
import type { UsagePayload } from "../src/server/usage";
import type { OpenCodeStatusPayload } from "../src/shared/opencode-status";

export const BASE_TIME = 1_800_000_000_000;

/** 認証だけを試すテスト用の空の利用枠。provider の取得には触れない。 */
export const EMPTY_USAGE: UsagePayload = { generatedAt: 0, sources: [] };

export async function stubOpenCodeStatus(): Promise<OpenCodeStatusPayload> {
  return { state: "error", snapshot: null };
}

export function stubFetchIntervals(): {
  read: () => { codex: number; "opencode-go": number };
  write: (provider: "codex" | "opencode-go", minutes: number) => { codex: number; "opencode-go": number };
} {
  let intervals = { codex: 600_000, "opencode-go": 600_000 };

  return {
    read: () => intervals,
    write: (provider, minutes) => {
      intervals = { ...intervals, [provider]: minutes * 60_000 };

      return intervals;
    },
  };
}

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

/** 認証だけを試すテスト用。Claude の取得は呼ばれたら記録だけする。 */
export type StubClaudeApi = {
  refresh: (mode: ClaudeRefreshMode) => Promise<ClaudeRefreshResult>;
  logout: () => Promise<boolean>;
};

export function stubClaudeApi(overrides: Partial<StubClaudeApi> = {}): StubClaudeApi {
  return {
    refresh: async () => ({ state: "skipped", reason: "fresh" }),
    logout: async () => true,
    ...overrides,
  };
}

export function stubOpenCodeApi(overrides: Partial<OpenCodeApi> = {}): OpenCodeApi {
  return {
    list: () => [],
    create: async () => ({ ok: true, value: stubAccount() }),
    update: async () => ({ ok: true, value: stubAccount() }),
    remove: async () => ({ ok: true, value: null }),
    refresh: async () => "ok",
    ...overrides,
  };
}

export function stubAccount(overrides: Partial<OpenCodeAccount> = {}): OpenCodeAccount {
  return {
    id: "account-1",
    name: "メイン",
    icon: "🦊",
    savedAt: BASE_TIME,
    probeModel: null,
    probeThinking: null,
    ...overrides,
  };
}

/** 認証だけを試すテスト用。probe の送信は呼ばれたら記録だけする。 */
export function stubProbeApi(overrides: Partial<ProbeApi> = {}): ProbeApi {
  return {
    models: () => EMPTY_CATALOG,
    codexConfig: () => null,
    setCodexConfig: () => ({ ok: true, value: { model: "model-a", thinking: "low" } }),
    clearCodexConfig: () => ({ ok: true, value: null }),
    checkCodex: async () => ({ ok: true, latencyMs: 1 }),
    checkOpenCode: async () => ({ ok: true, latencyMs: 1 }),
    ...overrides,
  };
}

export const EMPTY_CATALOG: ProbeCatalog = { codex: [], opencodeGo: [] };

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
