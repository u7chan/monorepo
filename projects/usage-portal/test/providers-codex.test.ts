// Codex の応答を「返ってきた窓だけ」正規化できることを固定する。
import { describe, expect, test } from "bun:test";
import { parseCodexUsage } from "../src/server/providers/codex";
import { ProviderError } from "../src/server/providers/types";

const CAPTURED = 1_800_000_000_000;

function usage(rateLimit: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  return { rate_limit: rateLimit, ...rest };
}

function codeOf(body: unknown): string {
  try {
    parseCodexUsage(body, CAPTURED);

    return "ok";
  } catch (error) {
    return error instanceof ProviderError ? error.code : "unexpected";
  }
}

describe("parseCodexUsage", () => {
  test("primary だけなら 1 窓、5 時間はローリング", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 12, limit_window_seconds: 5 * 3600, reset_at: 1_800_001_800 },
      }),
      CAPTURED,
    );

    expect(snapshot.provider).toBe("codex");
    expect(snapshot.windows).toEqual([
      {
        id: "primary",
        label: "ローリング",
        durationSeconds: 18_000,
        usedPercent: 12,
        resetsAt: 1_800_001_800_000,
      },
    ]);
  });

  test("primary + secondary は期間から rolling / weekly に振り分ける", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 40, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 71, limit_window_seconds: 604_800 },
      }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => [window.id, window.label])).toEqual([
      ["primary", "ローリング"],
      ["secondary", "週次"],
    ]);
  });

  test("週次が返らないアカウントでは週次の行を作らない", () => {
    const snapshot = parseCodexUsage(
      usage({ primary_window: { used_percent: 30, limit_window_seconds: 604_800 }, secondary_window: null }),
      CAPTURED,
    );

    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]?.label).toBe("週次");
  });

  test("percent を読めない窓は落とし、0% は残す", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 0, limit_window_seconds: 18_000 },
        secondary_window: { limit_window_seconds: 604_800 },
      }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([["primary", 0]]);
  });

  test("読める窓が 1 つも無ければ schema エラーにして前回の値を守る", () => {
    expect(codeOf(usage({ primary_window: null, secondary_window: null }))).toBe("schema");
    expect(codeOf({})).toBe("schema");
    expect(codeOf(null)).toBe("schema");
  });

  test("limit_reached と allowed=false のどちらでも上限到達", () => {
    expect(
      parseCodexUsage(usage({ limit_reached: true, primary_window: { used_percent: 10 } }), CAPTURED).limitReached,
    ).toBe(true);
    expect(
      parseCodexUsage(usage({ allowed: false, primary_window: { used_percent: 10 } }), CAPTURED).limitReached,
    ).toBe(true);
    expect(
      parseCodexUsage(usage({ primary_window: { used_percent: 10, allowed: false } }), CAPTURED).limitReached,
    ).toBe(true);
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED).limitReached).toBe(false);
  });

  test("クレジットとリセット枠は値があるときだけ注記する", () => {
    const withNotes = parseCodexUsage(
      usage(
        { primary_window: { used_percent: 10 } },
        { credits: { has_credits: true }, rate_limit_reset_credits: { available_count: 2 } },
      ),
      CAPTURED,
    );

    expect(withNotes.notes).toEqual(["クレジット残高あり", "リセット枠 2回"]);

    const withoutNotes = parseCodexUsage(
      usage(
        { primary_window: { used_percent: 10 } },
        { credits: { has_credits: false }, rate_limit_reset_credits: { available_count: 0 } },
      ),
      CAPTURED,
    );

    expect(withoutNotes.notes).toEqual([]);
  });

  test("上流が 100 を超えたら 100 に丸めて上限超過を注記する", () => {
    const snapshot = parseCodexUsage(usage({ primary_window: { used_percent: 120 } }), CAPTURED);

    expect(snapshot.windows[0]?.usedPercent).toBe(100);
    expect(snapshot.notes).toContain("上限超過");
  });

  test("reset_at が無ければ reset_after_seconds から取得時刻基準で計算する", () => {
    const snapshot = parseCodexUsage(
      usage({ primary_window: { used_percent: 10, reset_after_seconds: 600 } }),
      CAPTURED,
    );

    expect(snapshot.windows[0]?.resetsAt).toBe(CAPTURED + 10 * 60 * 1000);
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED).windows[0]?.resetsAt).toBeNull();
  });

  test("plan は表示用へ写し、未知の値は raw のまま出す", () => {
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 1 } }, { plan_type: "plus" }), CAPTURED).plan).toBe(
      "Plus",
    );
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 1 } }, { plan_type: "pro" }), CAPTURED).plan).toBe(
      "Pro",
    );
    expect(
      parseCodexUsage(usage({ primary_window: { used_percent: 1 } }, { plan_type: "mystery" }), CAPTURED).plan,
    ).toBe("mystery");
    expect(parseCodexUsage(usage({ primary_window: { used_percent: 1 } }), CAPTURED).plan).toBeNull();
  });

  test("limit_window_seconds を読めない窓は rolling に寄せる", () => {
    const snapshot = parseCodexUsage(usage({ primary_window: { used_percent: 10 } }), CAPTURED);

    expect(snapshot.windows[0]?.label).toBe("ローリング");
    expect(snapshot.windows[0]?.durationSeconds).toBeNull();
  });

  test("同じ期間の窓が 2 つなら第1枠 / 第2枠で区別する", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 18_000 },
      }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => window.label)).toEqual(["ローリング（第1枠）", "ローリング（第2枠）"]);
  });

  test("additional_rate_limits は v1 の対象外として無視する", () => {
    const snapshot = parseCodexUsage(
      usage({
        primary_window: { used_percent: 10 },
        additional_rate_limits: [{ used_percent: 90 }],
      }),
      CAPTURED,
    );

    expect(snapshot.windows).toHaveLength(1);
  });

  test("取得時刻と User-Agent 以外の上流値を snapshot に持ち込まない", () => {
    const snapshot = parseCodexUsage(
      usage(
        { primary_window: { used_percent: 10, reset_at: 1_800_001_800 } },
        {
          plan_type: "plus",
          email: "sentinel@example.invalid",
          user_id: "user-sentinel",
          account_id: "account-sentinel",
        },
      ),
      CAPTURED,
    );

    const json = JSON.stringify(snapshot);

    expect(json).not.toContain("sentinel");
    expect(snapshot.capturedAt).toBe(CAPTURED);
  });
});
