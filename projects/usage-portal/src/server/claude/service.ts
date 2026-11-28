import {
  deleteClaudeResetCredits,
  deleteProviderState,
  loadProviderUsage,
  saveClaudeResetCredits,
  saveClaudeResetCreditsError,
  saveProviderError,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../db";
import { CLAUDE_PROVIDER } from "../providers";
import { CLAUDE_REFRESH_INTERVAL_MS, fetchClaudeUsage } from "../providers/claude";
import { ProviderError, type ProviderErrorCode } from "../providers/types";
import type { ClaudeCli } from "./cli";
import { requestClaudeResetCredits, type ClaudeResetCreditsRead } from "./reset-credits";

/** 手動更新を続けて押したときに、CLI の起動を重ねないための間隔。 */
export const CLAUDE_MANUAL_COOLDOWN_MS = 60 * 1000;

/** 資格情報の破棄は公式 CLI に任せる。このアプリはトークンを読まない。 */
export const CLAUDE_LOGOUT_ARGS: readonly string[] = ["auth", "logout"];

/** `schedule` は開始予約の前後の確認。画面の要求からは選べず、15 分と 60 秒の制限を受けない。 */
export type ClaudeRefreshMode = "auto" | "manual" | "schedule";

export type ClaudeRefreshResult =
  | { state: "refreshed" }
  | { state: "skipped"; reason: "fresh" | "cooldown" | "logout" }
  | { state: "failed"; error: ProviderErrorCode };

export type ClaudeResetCreditsResult =
  | { state: "refreshed" }
  | { state: "failed"; error: ProviderErrorCode }
  | { state: "skipped"; reason: "logout" };

export type ClaudeUsageService = {
  refresh: (mode: ClaudeRefreshMode) => Promise<ClaudeRefreshResult>;
  /** 手動のときだけリセット枠を読む。通常の refresh からは呼ばない。 */
  resetCredits: () => Promise<ClaudeResetCreditsResult>;
  /** 公式 CLI でログアウトし、snapshot・error・リセット枠を消す。成功したら true。 */
  logout: () => Promise<boolean>;
};

/**
 * Claude の利用枠を、画面を開いたときと手動更新のときだけ取る。
 * 周期取得は持たない。同時要求は single-flight で 1 回にまとめ、失敗しても自動では再試行しない。
 */
export function createClaudeUsageService(options: {
  db: DatabaseHandle;
  cli: ClaudeCli;
  /** CLI が保存した資格情報のディレクトリ。リセット枠の読み取りだけが直接使う。 */
  credentialDir: string;
  userAgent: string;
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
  let resetInFlight: Promise<ClaudeResetCreditsResult> | null = null;
  // ログアウト開始時に進める。開始前に走っていた取得は、この値が変わったら結果を書かない。
  let generation = 0;
  let loggingOut = false;
  let pendingLogout: Promise<boolean> | null = null;

  async function attempt(startedAtGeneration: number): Promise<ClaudeRefreshResult> {
    lastRunAt = options.now();

    try {
      const snapshot = await fetchClaudeUsage({ cli: options.cli, now: options.now });

      if (startedAtGeneration !== generation) {
        return { state: "skipped", reason: "logout" };
      }

      saveProviderSnapshot(options.db, sourceId, snapshot);

      return { state: "refreshed" };
    } catch (error) {
      // 失敗も同じく書き戻さない。ログアウト直後に古い未接続を書くと、カードが戻ってしまう。
      if (startedAtGeneration !== generation) {
        return { state: "skipped", reason: "logout" };
      }

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
    // ログアウト中の取得は、終わったあとに資格情報の無い値で上書きするだけになる。
    if (loggingOut) {
      return Promise.resolve({ state: "skipped", reason: "logout" });
    }

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

    if (mode !== "schedule" && lastRunAt !== null && now - lastRunAt < cooldownMs) {
      return Promise.resolve({ state: "skipped", reason: "cooldown" });
    }

    const task = attempt(generation).finally(() => {
      inFlight = null;
    });

    inFlight = task;

    return task;
  }

  /**
   * リセット枠は手動のときだけ取る。token が無い・失効・401 のときは CLI に 1 回だけ更新させ、
   * 同じ要求を 1 回だけやり直す。refresh token の更新は CLI に任せ、Portal は書かない。
   */
  function resetCredits(): Promise<ClaudeResetCreditsResult> {
    if (loggingOut) {
      return Promise.resolve({ state: "skipped", reason: "logout" });
    }

    if (resetInFlight !== null) {
      return resetInFlight;
    }

    const task = attemptResetCredits(generation).finally(() => {
      resetInFlight = null;
    });

    resetInFlight = task;

    return task;
  }

  async function attemptResetCredits(startedAtGeneration: number): Promise<ClaudeResetCreditsResult> {
    const running = inFlight;

    // CLI が credentials を書き換えている間は読まない。終わってから token を読み直す。
    if (running !== null) {
      await running.catch(() => undefined);
    }

    let read = await requestClaudeResetCredits({
      credentialDir: options.credentialDir,
      userAgent: options.userAgent,
      now: options.now,
    });

    if (read.kind === "needs_credential" || read.kind === "unauthorized") {
      const refreshed = await refresh("schedule");

      if (refreshed.state === "failed") {
        return { state: "failed", error: refreshed.error };
      }

      if (refreshed.state === "skipped") {
        return { state: "skipped", reason: "logout" };
      }

      read = await requestClaudeResetCredits({
        credentialDir: options.credentialDir,
        userAgent: options.userAgent,
        now: options.now,
      });
    }

    if (startedAtGeneration !== generation) {
      return { state: "skipped", reason: "logout" };
    }

    if (read.kind === "ok") {
      saveClaudeResetCredits(options.db, { capturedAt: options.now(), credits: read.credits });

      return { state: "refreshed" };
    }

    const failure = resetCreditsError(read);

    try {
      saveClaudeResetCreditsError(options.db, { code: failure.code, message: failure.message, at: options.now() });
    } catch {
      log("claude: リセット枠の失敗を保存できませんでした");
    }

    log(`claude: reset credits ${failure.code} (${failure.message})`);

    return { state: "failed", error: failure.code };
  }

  /**
   * 取得は待たない。先に世代を進めて `loggingOut` を立てるので、進行中の取得は結果を書かない。
   * CLI の出力は読まず、成功しても失敗しても `loggingOut` は必ず下ろす。
   */
  function logout(): Promise<boolean> {
    if (pendingLogout !== null) {
      return pendingLogout;
    }

    generation += 1;
    loggingOut = true;

    const task = runLogout().finally(() => {
      loggingOut = false;
      pendingLogout = null;
    });

    pendingLogout = task;

    return task;
  }

  async function runLogout(): Promise<boolean> {
    try {
      await options.cli.run(CLAUDE_LOGOUT_ARGS);
    } catch {
      log("claude: ログアウトできませんでした");

      return false;
    }

    try {
      deleteProviderState(options.db, sourceId);
      deleteClaudeResetCredits(options.db);
    } catch {
      log("claude: ログアウト後の状態を削除できませんでした");

      return false;
    }

    // 再ログイン後の「接続を確認」が、前回の試行の 60 秒待ちにならないようにする。
    lastRunAt = null;

    return true;
  }

  return { refresh, resetCredits, logout };
}

function resetCreditsError(read: Exclude<ClaudeResetCreditsRead, { kind: "ok" }>): ProviderError {
  switch (read.kind) {
    case "needs_credential":
    case "unauthorized":
      return new ProviderError("reauth_required", "Claude のサインインの期限が切れています");
    case "schema":
      return new ProviderError("schema", "Claude のリセット枠を解釈できませんでした");
    default:
      return new ProviderError("upstream", "Claude からリセット枠を取得できませんでした");
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  // 想定外の例外文にはパスや環境が混ざり得る。分類だけを残し、文言は固定へ寄せる。
  return new ProviderError("upstream", "Claude から利用枠を取得できませんでした");
}
