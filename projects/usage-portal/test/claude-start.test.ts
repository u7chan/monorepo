// 開始予約の実行（送信前の確認・窓の終わりを待つ・見送り・失敗の数え方・停止・取りこぼし）を、
// 本物の SQLite と偽の取得・送信で固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRefreshResult } from "../src/server/claude/service";
import { createClaudeStartService, type ClaudeStartService } from "../src/server/claude/start";
import type { ClaudeStartSendResult } from "../src/server/claude/start-prompt";
import { openDatabase, type DatabaseHandle } from "../src/server/db";
import type { ProviderSnapshot } from "../src/server/providers/types";
import type { ClaudeStartSettings } from "../src/shared/claude-start";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const dirs: string[] = [];
const handles: DatabaseHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tokyo(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

const SETTINGS: ClaudeStartSettings = {
  anchorMinute: 22 * 60,
  count: 4,
  option: 3,
  days: [0, 1, 2, 3, 4, 5, 6],
  timeZone: "Asia/Tokyo",
  model: "haiku",
  effort: "low",
};

type Session = { usedPercent: number; resetsAt: number | null } | null;

function snapshot(session: Session, weeklyPercent = 10): ProviderSnapshot {
  return {
    provider: "claude",
    name: "Claude",
    plan: "Pro",
    capturedAt: 0,
    limitReached: false,
    notes: [],
    windows: [
      ...(session === null ? [] : [{ id: "rolling", label: "ローリング", durationSeconds: 18_000, ...session }]),
      { id: "weekly", label: "週次", durationSeconds: 604_800, usedPercent: weeklyPercent, resetsAt: null },
    ],
  };
}

/** 送信のたびに、その時刻から 5 時間の窓が始まる偽の Claude。 */
function harness(options: {
  start: number;
  session?: Session;
  weeklyPercent?: number;
  send?: () => ClaudeStartSendResult;
  refresh?: () => ClaudeRefreshResult;
}) {
  const dir = mkdtempSync(join(tmpdir(), "usage-portal-claude-start-"));
  const db = openDatabase(dir);

  dirs.push(dir);
  handles.push(db);

  let clock = options.start;
  let session: Session = options.session ?? null;
  const sends: number[] = [];
  const sleeps: number[] = [];

  const service: ClaudeStartService = createClaudeStartService({
    db,
    now: () => clock,
    refreshUsage: async () => options.refresh?.() ?? { state: "refreshed" },
    readSnapshot: () => {
      // 窓は終わったら消える。`/usage` は分単位で切り捨てた時刻を出す。
      const active = session !== null && session.resetsAt !== null && session.resetsAt > clock ? session : null;

      return snapshot(
        active === null ? null : { ...active, resetsAt: Math.floor((active.resetsAt ?? 0) / MINUTE) * MINUTE },
        options.weeklyPercent,
      );
    },
    send: async () => {
      sends.push(clock);

      const result = options.send?.() ?? { ok: true };

      if (result.ok) {
        session = { usedPercent: 1, resetsAt: clock + 5 * HOUR };
      }

      return result;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    setTimer: () => () => {},
    log: () => {},
  });

  return {
    service,
    sends,
    sleeps,
    setClock: (at: number) => {
      clock = at;
    },
    setSession: (value: Session) => {
      session = value;
    },
    enable: () => {
      service.saveSettings(SETTINGS);
      service.setEnabled(true);
    },
  };
}

describe("予約の実行", () => {
  test("枠の時刻に窓が動いていなければ送り、送信後の確認で得たリセット時刻を残す", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00") });

    h.enable();
    h.setClock(tokyo("2026-11-20", "07:00"));
    await h.service.tick();

    expect(h.sends).toEqual([tokyo("2026-11-20", "07:00")]);
    expect(h.service.state().runs[0]).toMatchObject({
      kind: "auto",
      slotAt: tokyo("2026-11-20", "07:00"),
      outcome: "ok",
      resetsAt: tokyo("2026-11-20", "12:00"),
    });
  });

  test("自分で始めた窓の終わりは、送信時刻の 5 時間 15 秒後まで待ってから送る", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00") });

    h.enable();
    h.setClock(tokyo("2026-11-20", "07:00") + 40_000);
    await h.service.tick();
    h.setClock(tokyo("2026-11-20", "12:00") + 10);
    await h.service.tick();

    expect(h.sends[1]).toBe(tokyo("2026-11-20", "12:00") + 40_000 + 15_000);
  });

  test("ほかの利用で始まった窓は、表示のリセット時刻の 2 分後まで待つ", async () => {
    const h = harness({
      start: tokyo("2026-11-20", "06:00"),
      session: { usedPercent: 30, resetsAt: tokyo("2026-11-20", "07:10") },
    });

    h.enable();
    h.setClock(tokyo("2026-11-20", "07:00"));
    await h.service.tick();

    expect(h.sends).toEqual([tokyo("2026-11-20", "07:12")]);
  });

  test("窓の終わりが 30 分より先なら送らず、見送りとして残す", async () => {
    const h = harness({
      start: tokyo("2026-11-20", "06:00"),
      session: { usedPercent: 30, resetsAt: tokyo("2026-11-20", "09:40") },
    });

    h.enable();
    h.setClock(tokyo("2026-11-20", "07:00"));
    await h.service.tick();

    expect(h.sends).toEqual([]);
    expect(h.service.state().runs[0]).toMatchObject({
      outcome: "skipped",
      code: "active",
      resetsAt: tokyo("2026-11-20", "09:40"),
    });
  });

  test("週次が 100% なら送らない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00"), weeklyPercent: 100 });

    h.enable();
    h.setClock(tokyo("2026-11-20", "07:00"));
    await h.service.tick();

    expect(h.sends).toEqual([]);
    expect(h.service.state().runs[0]).toMatchObject({ outcome: "skipped", code: "weekly_limit" });
  });

  test("同じ枠は 2 回実行しない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00") });

    h.enable();
    h.setClock(tokyo("2026-11-20", "07:00"));
    await h.service.tick();
    h.setClock(tokyo("2026-11-20", "07:05"));
    await h.service.tick();

    expect(h.sends).toHaveLength(1);
  });

  test("再起動で 30 分を過ぎた枠は送らず、時刻を過ぎたとして 1 回だけ残す", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00") });

    h.enable();

    // 有効化の後に作り直すと、再起動と同じく取りこぼしを拾う。
    const restarted = createClaudeStartService({
      db: handles[0] as DatabaseHandle,
      now: () => tokyo("2026-11-20", "08:00"),
      refreshUsage: async () => ({ state: "refreshed" }),
      readSnapshot: () => snapshot(null),
      send: async () => {
        throw new Error("送らない");
      },
      setTimer: () => () => {},
      log: () => {},
    });

    await restarted.tick();
    await restarted.tick();

    const runs = restarted.state().runs;

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "skipped", code: "missed", slotAt: tokyo("2026-11-20", "07:00") });
  });

  test("有効にする前の枠は、30 分以内でも遅れて送らない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "07:10") });

    h.enable();
    await h.service.tick();

    expect(h.sends).toEqual([]);
    expect(h.service.state().runs).toEqual([]);
  });

  test("オフの間は送らない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00") });

    h.service.saveSettings(SETTINGS);
    h.setClock(tokyo("2026-11-20", "07:00"));
    await h.service.tick();

    expect(h.sends).toEqual([]);
  });
});

describe("失敗の数え方と停止", () => {
  async function runSlots(h: ReturnType<typeof harness>, times: string[]): Promise<void> {
    for (const time of times) {
      h.setClock(tokyo("2026-11-20", time));
      await h.service.tick();
    }
  }

  test("3 回続けて失敗したら予約をオフにし、理由を残す", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00"), send: () => ({ ok: false, error: "reauth_required" }) });

    h.enable();
    await runSlots(h, ["07:00", "12:00"]);

    expect(h.service.state()).toMatchObject({ enabled: true, failures: 2 });

    await runSlots(h, ["17:00"]);

    expect(h.service.state()).toMatchObject({ enabled: false, failures: 3, stoppedCode: "reauth_required" });

    await runSlots(h, ["22:00"]);

    expect(h.sends).toHaveLength(3);
  });

  test("上限（429）は見送りとして残し、失敗に数えない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00"), send: () => ({ ok: false, error: "limit_reached" }) });

    h.enable();
    await runSlots(h, ["07:00", "12:00", "17:00"]);

    expect(h.service.state()).toMatchObject({ enabled: true, failures: 0 });
    expect(h.service.state().runs[0]).toMatchObject({ outcome: "skipped", code: "limit_reached" });
  });

  test("送信前の確認の失敗も失敗に数える", async () => {
    const h = harness({
      start: tokyo("2026-11-20", "06:00"),
      refresh: () => ({ state: "failed", error: "reauth_required" }),
    });

    h.enable();
    await runSlots(h, ["07:00"]);

    expect(h.sends).toEqual([]);
    expect(h.service.state()).toMatchObject({ failures: 1 });
    expect(h.service.state().runs[0]).toMatchObject({ outcome: "failed", code: "reauth_required" });
  });

  test("成功すると連続失敗の数を 0 に戻す", async () => {
    let fail = true;
    const h = harness({
      start: tokyo("2026-11-20", "06:00"),
      send: () => (fail ? { ok: false, error: "unavailable" } : { ok: true }),
    });

    h.enable();
    await runSlots(h, ["07:00"]);
    fail = false;
    await runSlots(h, ["12:00"]);

    expect(h.service.state().failures).toBe(0);
  });

  test("オンに戻すと再開し、連続失敗の数と停止の理由を消す", async () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00"), send: () => ({ ok: false, error: "unavailable" }) });

    h.enable();
    await runSlots(h, ["07:00", "12:00", "17:00"]);
    h.service.setEnabled(true);

    expect(h.service.state()).toMatchObject({ enabled: true, failures: 0, stoppedCode: null });
  });

  test("ログアウトで無効にする", () => {
    const h = harness({ start: tokyo("2026-11-20", "06:00") });

    h.enable();
    h.service.disable();

    expect(h.service.state()).toMatchObject({ enabled: false, nextStartAt: null });
  });
});

describe("今すぐ開始", () => {
  test("窓が動いていれば待たずに見送る", async () => {
    const h = harness({
      start: tokyo("2026-11-20", "10:00"),
      session: { usedPercent: 5, resetsAt: tokyo("2026-11-20", "10:05") },
    });

    h.service.saveSettings(SETTINGS);

    expect(await h.service.runNow()).toEqual({
      outcome: "skipped",
      code: "active",
      resetsAt: tokyo("2026-11-20", "10:05"),
    });
    expect(h.sleeps).toEqual([]);
  });

  test("失敗しても予約の連続失敗には数えない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "10:00"), send: () => ({ ok: false, error: "unavailable" }) });

    h.enable();
    await h.service.runNow();

    expect(h.service.state()).toMatchObject({ enabled: true, failures: 0 });
    expect(h.service.state().runs[0]).toMatchObject({ kind: "manual", outcome: "failed" });
  });

  test("設定が無ければ送らない", async () => {
    const h = harness({ start: tokyo("2026-11-20", "10:00") });

    expect(await h.service.runNow()).toEqual({ outcome: "aborted" });
    expect(h.sends).toEqual([]);
  });
});

describe("設定", () => {
  test("不正な設定は保存しない", () => {
    const h = harness({ start: tokyo("2026-11-20", "10:00") });

    expect(h.service.saveSettings({ ...SETTINGS, count: 5 })).toBeNull();
    expect(h.service.state().settings).toBeNull();
  });

  test("設定が無いままオンにはできない", () => {
    const h = harness({ start: tokyo("2026-11-20", "10:00") });

    expect(h.service.setEnabled(true)).toBe("not_configured");
  });

  test("保存してもオン・オフは変えず、オンのときだけ次の開始を返す", () => {
    const h = harness({ start: tokyo("2026-11-20", "10:00") });

    expect(h.service.saveSettings(SETTINGS)).toMatchObject({ enabled: false, nextStartAt: null });

    h.service.setEnabled(true);

    expect(h.service.state().nextStartAt).toBe(tokyo("2026-11-20", "12:00"));
  });
});
