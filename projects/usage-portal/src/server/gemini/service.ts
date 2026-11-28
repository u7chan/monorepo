import { unlink } from "node:fs/promises";
import {
  deleteProviderState,
  loadProviderUsage,
  saveProviderError,
  saveProviderSnapshot,
  type DatabaseHandle,
} from "../db";
import { GEMINI_PROVIDER } from "../providers";
import { GEMINI_REFRESH_INTERVAL_MS, fetchGeminiUsage, readGeminiConnection } from "../providers/gemini";
import { ProviderError, type ProviderErrorCode } from "../providers/types";
import { geminiTokenPath, type GeminiCli } from "./cli";

/** 手動更新を続けて押したときに、CLI の起動を重ねないための間隔。 */
export const GEMINI_MANUAL_COOLDOWN_MS = 60 * 1000;

/** 画面の要求から選べるのは自動と手動だけ。 */
export type GeminiRefreshMode = "auto" | "manual";

export type GeminiRefreshResult =
  | { state: "refreshed" }
  | { state: "skipped"; reason: "fresh" | "cooldown" | "logout" }
  | { state: "failed"; error: ProviderErrorCode };

/** `incomplete` は token を消したあとも CLI が接続済みと答えた状態。`failed` は消せなかった・確かめられなかった状態。 */
export type GeminiLogoutResult = "done" | "incomplete" | "failed";

export type GeminiUsageService = {
  refresh: (mode: GeminiRefreshMode) => Promise<GeminiRefreshResult>;
  /** 進行中の取得を待ち、token を消し、`agy models` で未接続を確かめてから snapshot と error を消す。 */
  logout: () => Promise<GeminiLogoutResult>;
};

/**
 * Gemini の利用枠を、画面を開いたときと手動更新のときだけ取る。
 * 周期取得は持たない。同時要求は single-flight で 1 回にまとめ、失敗しても自動では再試行しない。
 */
export function createGeminiUsageService(options: {
  db: DatabaseHandle;
  cli: GeminiCli;
  /** CLI の `HOME` を置く場所。ログアウトが token のパスを引くためだけに使う。 */
  credentialDir: string;
  now: () => number;
  /** 最後の試行からこの時間以内なら自動の取得を起動しない。 */
  autoIntervalMs?: number;
  cooldownMs?: number;
  log?: (message: string) => void;
}): GeminiUsageService {
  const sourceId = GEMINI_PROVIDER.id;
  const tokenPath = geminiTokenPath(options.credentialDir);
  const autoIntervalMs = options.autoIntervalMs ?? GEMINI_REFRESH_INTERVAL_MS;
  const cooldownMs = options.cooldownMs ?? GEMINI_MANUAL_COOLDOWN_MS;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  // 手動の 60 秒の下限に使う。成功・失敗のどちらでも、CLI を起こした時刻を覚える。
  let lastRunAt: number | null = null;
  let inFlight: Promise<GeminiRefreshResult> | null = null;
  // ログアウト開始時に進める。開始前に走っていた取得は、この値が変わったら結果を書かない。
  let generation = 0;
  let loggingOut = false;
  let pendingLogout: Promise<GeminiLogoutResult> | null = null;

  async function attempt(startedAtGeneration: number): Promise<GeminiRefreshResult> {
    lastRunAt = options.now();

    try {
      const snapshot = await fetchGeminiUsage({ cli: options.cli, now: options.now });

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

      try {
        saveProviderError(options.db, sourceId, {
          code: failure.code,
          message: failure.message,
          at: options.now(),
        });
      } catch {
        log("gemini: 取得の失敗を保存できませんでした");
      }

      log(`gemini: ${failure.code} (${failure.message})`);

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

  function refresh(mode: GeminiRefreshMode): Promise<GeminiRefreshResult> {
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

    if (lastRunAt !== null && now - lastRunAt < cooldownMs) {
      return Promise.resolve({ state: "skipped", reason: "cooldown" });
    }

    const task = attempt(generation).finally(() => {
      inFlight = null;
    });

    inFlight = task;

    return task;
  }

  function logout(): Promise<GeminiLogoutResult> {
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

  /**
   * 取得と直列にする。Claude と違い進行中の取得を待つのは、CLI が token を書き戻す余地を残さないため。
   * token は読まずに消し、`agy models` が未接続と答えたときだけ状態を消す。
   */
  async function runLogout(): Promise<GeminiLogoutResult> {
    const running = inFlight;

    if (running !== null) {
      await running.catch(() => undefined);
    }

    try {
      await unlink(tokenPath);
    } catch (error) {
      // 既に無いなら消した状態と同じ。確認へ進む。
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        log("gemini: ログアウトで token を削除できませんでした");

        return "failed";
      }
    }

    let connection: Awaited<ReturnType<typeof readGeminiConnection>>;

    try {
      connection = await readGeminiConnection(options.cli);
    } catch {
      log("gemini: ログアウトを確認できませんでした");

      return "failed";
    }

    if (connection === "connected") {
      log("gemini: token を削除しても接続が残っています");

      return "incomplete";
    }

    try {
      deleteProviderState(options.db, sourceId);
    } catch {
      log("gemini: ログアウト後の状態を削除できませんでした");

      return "failed";
    }

    // 再サインイン後の「接続を確認」が、前回の試行の 60 秒待ちにならないようにする。
    lastRunAt = null;

    return "done";
  }

  return { refresh, logout };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  // 想定外の例外文にはパスや環境が混ざり得る。分類だけを残し、文言は固定へ寄せる。
  return new ProviderError("upstream", "Gemini から利用枠を取得できませんでした");
}
