import { loadProviderUsage, saveProviderError, saveProviderSnapshot, type DatabaseHandle } from "../db";
import { CLAUDE_PROVIDER } from "../providers";
import { CLAUDE_REFRESH_INTERVAL_MS, fetchClaudeUsage } from "../providers/claude";
import { ProviderError, type ProviderErrorCode } from "../providers/types";
import type { ClaudeCli } from "./cli";

/** 手動更新を続けて押したときに、CLI の起動を重ねないための間隔。 */
export const CLAUDE_MANUAL_COOLDOWN_MS = 60 * 1000;

export type ClaudeRefreshMode = "auto" | "manual";

export type ClaudeRefreshResult =
  | { state: "refreshed" }
  | { state: "skipped"; reason: "fresh" | "cooldown" }
  | { state: "failed"; error: ProviderErrorCode };

export type ClaudeUsageService = {
  refresh: (mode: ClaudeRefreshMode) => Promise<ClaudeRefreshResult>;
};

/**
 * Claude の利用枠を、画面を開いたときと手動更新のときだけ取る。
 * 周期取得は持たない。同時要求は single-flight で 1 回にまとめ、失敗しても自動では再試行しない。
 */
export function createClaudeUsageService(options: {
  db: DatabaseHandle;
  cli: ClaudeCli;
  now: () => number;
  /** 前回取得からこの時間以内なら自動の取得を起動しない。 */
  autoIntervalMs?: number;
  cooldownMs?: number;
  log?: (message: string) => void;
}): ClaudeUsageService {
  const sourceId = CLAUDE_PROVIDER.id;
  const autoIntervalMs = options.autoIntervalMs ?? CLAUDE_REFRESH_INTERVAL_MS;
  const cooldownMs = options.cooldownMs ?? CLAUDE_MANUAL_COOLDOWN_MS;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  // 成功・失敗のどちらでも「最後に CLI を起こした時刻」を覚える。失敗直後の連打で叩き続けないため。
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<ClaudeRefreshResult> | null = null;

  async function attempt(): Promise<ClaudeRefreshResult> {
    lastAttemptAt = options.now();

    try {
      const snapshot = await fetchClaudeUsage({ cli: options.cli, now: options.now });

      saveProviderSnapshot(options.db, sourceId, snapshot);

      return { state: "refreshed" };
    } catch (error) {
      const failure = toProviderError(error);
      const at = options.now();

      try {
        saveProviderError(options.db, sourceId, { code: failure.code, message: failure.message, at });
      } catch {
        log("claude: 取得の失敗を保存できませんでした");
      }

      log(`claude: ${failure.code} (${failure.message})`);

      return { state: "failed", error: failure.code };
    }
  }

  function isFresh(now: number): boolean {
    try {
      const snapshot = loadProviderUsage(options.db, [sourceId]).get(sourceId)?.snapshot ?? null;

      return snapshot !== null && now - snapshot.capturedAt <= autoIntervalMs;
    } catch {
      // 読めないときは「新しい」と決めつけず、取得を試す。失敗すれば error が残る。
      return false;
    }
  }

  function refresh(mode: ClaudeRefreshMode): Promise<ClaudeRefreshResult> {
    if (inFlight !== null) {
      return inFlight;
    }

    const now = options.now();

    if (mode === "auto" && isFresh(now)) {
      return Promise.resolve({ state: "skipped", reason: "fresh" });
    }

    if (lastAttemptAt !== null && now - lastAttemptAt < cooldownMs) {
      return Promise.resolve({ state: "skipped", reason: "cooldown" });
    }

    const task = attempt().finally(() => {
      inFlight = null;
    });

    inFlight = task;

    return task;
  }

  return { refresh };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  // 想定外の例外文にはパスや環境が混ざり得る。分類だけを残し、文言は固定へ寄せる。
  return new ProviderError("upstream", "Claude から利用枠を取得できませんでした");
}
