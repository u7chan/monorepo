import {
  CLAUDE_START_MAX_FAILURES,
  CLAUDE_START_WINDOW_MINUTES,
  latestStartSlot,
  nextStartSlot,
  readClaudeStartSettings,
  startSlots,
  type ClaudeStartSettings,
} from "../../shared/claude-start";
import {
  hasClaudeStartRunForSlot,
  insertClaudeStartRun,
  loadClaudeStart,
  loadClaudeStartRuns,
  pruneClaudeStartRuns,
  saveClaudeStart,
  type ClaudeStartRunRow,
  type DatabaseHandle,
  type StoredClaudeStart,
} from "../db";
import type { ProviderSnapshot } from "../providers/types";
import type { ClaudeRefreshResult } from "./service";
import type { ClaudeStartSendResult } from "./start-prompt";

const MINUTE_MS = 60_000;
const WINDOW_MS = CLAUDE_START_WINDOW_MINUTES * MINUTE_MS;
/** 枠の時刻からこれ以上遅れたら送らない（サーバー停止など）。窓の終わりを待つのもこの範囲まで。 */
const GRACE_MS = 30 * MINUTE_MS;
/** 自分で開始した窓は、送信時刻の 5 時間後のこれだけあとに次を送る。 */
const OWN_MARGIN_MS = 15_000;
/** 自分で開始していない窓は `/usage` の分単位の時刻しか分からないので、余裕を大きく取る。 */
const FOREIGN_MARGIN_MS = 2 * MINUTE_MS;
/** timer は最長でもこの間隔で起こし直す。時計の補正や長い sleep の取りこぼしを拾うため。 */
const MAX_TIMER_MS = 60 * MINUTE_MS;
const RUN_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
/**
 * 期限の来た枠を探す範囲。曜日を 1 つだけ選ぶと枠の間隔は最大 7 日になるので、停止中に過ぎた枠を
 * 見送りとして残せるよう、それより少し長くさかのぼる。
 */
const DUE_LOOKBACK_MS = 8 * 24 * 60 * MINUTE_MS;
const HISTORY_LIMIT = 20;

export type ClaudeStartRun = ClaudeStartRunRow;

export type ClaudeStartState = {
  settings: ClaudeStartSettings | null;
  enabled: boolean;
  failures: number;
  stoppedCode: string | null;
  running: boolean;
  /** 次に窓が始まる時刻。窓を待つなら、送信してよい時刻。 */
  nextStartAt: number | null;
  runs: ClaudeStartRun[];
};

export type ClaudeStartRunResult =
  | { outcome: "ok"; resetsAt: number | null }
  | { outcome: "skipped"; code: string; resetsAt: number | null }
  | { outcome: "failed"; code: string }
  | { outcome: "busy" }
  | { outcome: "aborted" };

export type ClaudeStartService = {
  state: () => ClaudeStartState;
  saveSettings: (settings: unknown) => ClaudeStartState | null;
  setEnabled: (enabled: boolean) => ClaudeStartState | "not_configured";
  runNow: () => Promise<ClaudeStartRunResult>;
  /** ログアウトしたら予約を無効にする。カードが消えたあとも裏で送り続けない。 */
  disable: () => void;
  /** 期限の来た枠があれば実行する。timer から呼ぶほか、テストから直接呼ぶ。 */
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
};

type RunKind = "auto" | "manual";

export function createClaudeStartService(options: {
  db: DatabaseHandle;
  now: () => number;
  /** 送信前後の確認。開始予約用の制限なしの取得で、結果は DB に保存される。 */
  refreshUsage: () => Promise<ClaudeRefreshResult>;
  readSnapshot: () => ProviderSnapshot | null;
  send: (settings: ClaudeStartSettings) => Promise<ClaudeStartSendResult>;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (callback: () => void, ms: number) => () => void;
  log?: (message: string) => void;
}): ClaudeStartService {
  const { db, now } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);

      return () => clearTimeout(timer);
    });
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  let running = false;
  /** 実行中の枠。窓の終わりを待っているあいだも入る。 */
  let pendingSlotAt: number | null = null;
  let cancelTimer: (() => void) | null = null;
  let started = false;

  function load(): { stored: StoredClaudeStart | null; settings: ClaudeStartSettings | null } {
    let stored: StoredClaudeStart | null;

    try {
      stored = loadClaudeStart(db);
    } catch {
      log("claude-start: 予約を読めませんでした");

      return { stored: null, settings: null };
    }

    if (stored === null) {
      return { stored: null, settings: null };
    }

    let settings: ClaudeStartSettings | null = null;

    try {
      settings = readClaudeStartSettings(JSON.parse(stored.settingsJson));
    } catch {
      settings = null;
    }

    return { stored, settings };
  }

  function update(patch: Partial<StoredClaudeStart>): void {
    const { stored } = load();

    if (stored !== null) {
      saveClaudeStart(db, { ...stored, ...patch });
    }
  }

  /**
   * 次に 5 時間窓が始まる時刻。動いている窓を待つなら、送信してよい時刻になる。
   * 画面はこの 1 値と窓のリセット時刻だけでフッターを組み立てる（判定を写し間違えないため）。
   */
  function nextStartTime(settings: ClaudeStartSettings, stored: StoredClaudeStart | null, at: number): number | null {
    const resetsAt = options.readSnapshot()?.windows.find((window) => window.id === "rolling")?.resetsAt ?? null;
    const end = resetsAt === null ? null : windowEnd(resetsAt, stored?.lastSentAt ?? null);

    if (pendingSlotAt !== null) {
      return end !== null && end.sendAt > pendingSlotAt ? end.sendAt : pendingSlotAt;
    }

    const next = nextStartSlot(settings, at);

    if (next === null) {
      return null;
    }

    const slot =
      startSlots(settings, next, next + DUE_LOOKBACK_MS).find(
        (candidate) => end === null || end.sendAt <= candidate + GRACE_MS,
      ) ?? next;

    return end !== null && end.sendAt > slot ? end.sendAt : slot;
  }

  function state(): ClaudeStartState {
    const { stored, settings } = load();
    const enabled = stored?.enabled === true && settings !== null;
    let runs: ClaudeStartRun[] = [];

    try {
      runs = loadClaudeStartRuns(db, HISTORY_LIMIT);
    } catch {
      log("claude-start: 履歴を読めませんでした");
    }

    return {
      settings,
      enabled,
      failures: stored?.failures ?? 0,
      stoppedCode: stored?.stoppedCode ?? null,
      running,
      nextStartAt: enabled && settings !== null ? nextStartTime(settings, stored, now()) : null,
      runs,
    };
  }

  function record(run: Omit<ClaudeStartRunRow, "ranAt">): void {
    const ranAt = now();

    try {
      insertClaudeStartRun(db, { ...run, ranAt });
      pruneClaudeStartRuns(db, ranAt - RUN_RETENTION_MS);
    } catch {
      log("claude-start: 履歴を保存できませんでした");
    }
  }

  function rolling(snapshot: ProviderSnapshot | null) {
    return snapshot?.windows.find((window) => window.id === "rolling") ?? null;
  }

  /**
   * `/usage` の時刻は分で切り捨てて出るので、表示の 1 分後までは窓が残っている可能性がある。
   * 自分の送信で始めた窓だけは、送信時刻から終わりを秒単位で決められる。
   */
  function windowEnd(resetsAt: number, lastSentAt: number | null): { end: number; sendAt: number } {
    if (lastSentAt !== null) {
      const ownEnd = lastSentAt + WINDOW_MS;

      if (ownEnd >= resetsAt && ownEnd - resetsAt < MINUTE_MS) {
        return { end: ownEnd, sendAt: ownEnd + OWN_MARGIN_MS };
      }
    }

    return { end: resetsAt + MINUTE_MS, sendAt: resetsAt + FOREIGN_MARGIN_MS };
  }

  async function execute(kind: RunKind, slotAt: number | null): Promise<ClaudeStartRunResult> {
    const finish = (result: ClaudeStartRunResult): ClaudeStartRunResult => {
      if (result.outcome === "busy" || result.outcome === "aborted") {
        return result;
      }

      record({
        kind,
        slotAt,
        outcome: result.outcome,
        code: result.outcome === "ok" ? null : result.code,
        resetsAt: result.outcome === "failed" ? null : result.resetsAt,
      });

      if (kind === "auto") {
        countFailure(result);
      }

      return result;
    };

    // 窓の終わりを待つのは 1 回で足りる。待ったあとも動いていれば、他の利用で窓が延びている。
    for (let attempt = 0; ; attempt += 1) {
      const current = load();

      if (current.settings === null || (kind === "auto" && current.stored?.enabled !== true)) {
        return { outcome: "aborted" };
      }

      const checked = await options.refreshUsage();

      if (checked.state === "skipped") {
        return { outcome: "aborted" };
      }

      if (checked.state === "failed") {
        return finish({ outcome: "failed", code: checked.error });
      }

      const snapshot = options.readSnapshot();
      const weekly = snapshot?.windows.find((window) => window.id === "weekly") ?? null;

      if (weekly !== null && weekly.usedPercent >= 100) {
        return finish({ outcome: "skipped", code: "weekly_limit", resetsAt: weekly.resetsAt });
      }

      const session = rolling(snapshot);
      const at = now();

      const end = session?.resetsAt == null ? null : windowEnd(session.resetsAt, current.stored?.lastSentAt ?? null);

      if (session !== null && session.resetsAt !== null && end !== null && end.end > at) {
        if (kind === "auto" && slotAt !== null && attempt === 0 && end.sendAt <= slotAt + GRACE_MS) {
          await sleep(Math.max(0, end.sendAt - at));
          continue;
        }

        return finish({
          outcome: "skipped",
          code: session.usedPercent >= 100 ? "session_limit" : "active",
          resetsAt: session.resetsAt,
        });
      }

      const sentAt = now();
      const sent = await options.send(current.settings);

      if (!sent.ok) {
        return sent.error === "limit_reached"
          ? finish({ outcome: "skipped", code: "limit_reached", resetsAt: null })
          : finish({ outcome: "failed", code: sent.error });
      }

      update({ lastSentAt: sentAt });

      // 送信は済んでいる。確認に失敗しても成功として残し、リセット時刻だけを空にする。
      const after = await options.refreshUsage();
      const resetsAt = after.state === "refreshed" ? (rolling(options.readSnapshot())?.resetsAt ?? null) : null;

      return finish({ outcome: "ok", resetsAt });
    }
  }

  function countFailure(result: ClaudeStartRunResult): void {
    const { stored } = load();

    if (stored === null) {
      return;
    }

    if (result.outcome === "ok") {
      saveClaudeStart(db, { ...stored, failures: 0 });

      return;
    }

    if (result.outcome !== "failed") {
      return;
    }

    const failures = stored.failures + 1;

    if (failures >= CLAUDE_START_MAX_FAILURES) {
      saveClaudeStart(db, { ...stored, failures, enabled: false, stoppedCode: result.code });
      log(`claude-start: ${failures} 回続けて失敗したため予約を止めました (${result.code})`);

      return;
    }

    saveClaudeStart(db, { ...stored, failures });
  }

  async function run(kind: RunKind, slotAt: number | null): Promise<ClaudeStartRunResult> {
    if (running) {
      return { outcome: "busy" };
    }

    running = true;
    pendingSlotAt = slotAt;

    try {
      return await execute(kind, slotAt);
    } catch {
      log("claude-start: 実行中に想定外のエラーが起きました");

      return { outcome: "aborted" };
    } finally {
      running = false;
      pendingSlotAt = null;
    }
  }

  async function tick(): Promise<void> {
    const { stored, settings } = load();

    if (running || settings === null || stored?.enabled !== true) {
      return;
    }

    const at = now();
    const due = latestStartSlot(settings, at, DUE_LOOKBACK_MS);

    // 有効化・設定の保存より前の枠は、再起動をまたいでも遅れて送ったり見送りとして残したりしない。
    if (due === null || due < stored.armedAt) {
      return;
    }

    let handled: boolean;

    try {
      handled = hasClaudeStartRunForSlot(db, due);
    } catch {
      log("claude-start: 履歴を読めませんでした");

      return;
    }

    if (handled) {
      return;
    }

    if (at - due > GRACE_MS) {
      record({ kind: "auto", slotAt: due, outcome: "skipped", code: "missed", resetsAt: null });

      return;
    }

    await run("auto", due);
  }

  function schedule(): void {
    cancelTimer?.();
    cancelTimer = null;

    if (!started) {
      return;
    }

    const { stored, settings } = load();
    const at = now();
    const next = stored?.enabled === true && settings !== null ? nextStartSlot(settings, at) : null;
    const delay = next === null ? MAX_TIMER_MS : Math.min(MAX_TIMER_MS, Math.max(0, next - at));

    cancelTimer = setTimer(() => {
      void tick().finally(schedule);
    }, delay);
  }

  return {
    state,
    saveSettings(input) {
      const settings = readClaudeStartSettings(input);

      if (settings === null) {
        return null;
      }

      const { stored } = load();

      saveClaudeStart(db, {
        settingsJson: JSON.stringify(settings),
        enabled: stored?.enabled ?? false,
        failures: stored?.failures ?? 0,
        stoppedCode: stored?.stoppedCode ?? null,
        lastSentAt: stored?.lastSentAt ?? null,
        armedAt: now(),
      });
      schedule();

      return state();
    },
    setEnabled(enabled) {
      const { stored, settings } = load();

      if (stored === null || settings === null) {
        return "not_configured";
      }

      // オンに戻すのが停止からの再開になる。オフにしたときも停止の理由は消す（利用者が止めた状態になる）。
      saveClaudeStart(db, { ...stored, enabled, failures: 0, stoppedCode: null, armedAt: now() });
      schedule();

      return state();
    },
    runNow: () => run("manual", null),
    disable() {
      update({ enabled: false, stoppedCode: null, failures: 0 });
      schedule();
    },
    tick,
    start() {
      started = true;
      void tick().finally(schedule);
    },
    stop() {
      started = false;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
