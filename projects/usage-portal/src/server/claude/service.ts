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
  /** 最後の試行からこの時間以内なら自動の取得を起動しない。 */
  autoIntervalMs?: number;
  cooldownMs?: number;
  log?: (message: string) => void;
}): ClaudeUsageService {
  const sourceId = CLAUDE_PROVIDER.id;
  const autoIntervalMs = options.autoIntervalMs ?? CLAUDE_REFRESH_INTERVAL_MS;
  const cooldownMs = options.cooldownMs ?? CLAUDE_MANUAL_COOLDOWN_MS;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  // 手動の 60 秒の下限に使う。成功・失敗のどちらでも、CLI を起こした時刻を覚える。
  let lastRunAt: number | null = null;
  let inFlight: Promise<ClaudeRefreshResult> | null = null;

  async function attempt(): Promise<ClaudeRefreshResult> {
    lastRunAt = options.now();

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

  /**
   * 最後の試行（成功は snapshot、失敗は provider_error）の時刻。
   * 失敗の直後も 15 分は auto を起こさないため、再起動をまたいで残る DB の値を使う。
   */
  function lastAttemptAt(): number | null {
    try {
      const stored = loadProviderUsage(options.db, [sourceId]).get(sourceId);
      const capturedAt = stored?.snapshot?.capturedAt ?? null;
      const failedAt = stored?.error?.at ?? null;

      if (capturedAt === null) {
        return failedAt;
      }

      return failedAt === null ? capturedAt : Math.max(capturedAt, failedAt);
    } catch {
      // 読めないときは「新しい」と決めつけず、取得を試す。失敗すれば error が残る。
      return null;
    }
  }

  function refresh(mode: ClaudeRefreshMode): Promise<ClaudeRefreshResult> {
    if (inFlight !== null) {
      return inFlight;
    }

    const now = options.now();

    if (mode === "auto") {
      const lastAttempt = lastAttemptAt();

      if (lastAttempt !== null && now - lastAttempt <= autoIntervalMs) {
        return Promise.resolve({ state: "skipped", reason: "fresh" });
      }
    }

    if (lastRunAt !== null && now - lastRunAt < cooldownMs) {
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
