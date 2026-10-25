// OpenCode Go の応答を 3 窓へ正規化し、欠損を 0% と誤表示しないことを固定する。
import { describe, expect, test } from "bun:test";
import { fetchOpenCodeUsage, parseOpenCodeUsage } from "../src/server/providers/opencode-go";
import { ProviderError } from "../src/server/providers/types";

const CAPTURED = 1_800_000_000_000;

function usage(windows: Record<string, unknown>) {
  return { usage: windows };
}

function codeOf(body: unknown): string {
  try {
    parseOpenCodeUsage(body, CAPTURED);

    return "ok";
  } catch (error) {
    return error instanceof ProviderError ? error.code : "unexpected";
  }
}

describe("parseOpenCodeUsage", () => {
  test("rolling / weekly / monthly の 3 窓を返す", () => {
    const snapshot = parseOpenCodeUsage(
      usage({
        rolling: { status: "ok", percent: 35, resetsAt: "2026-10-18T09:36:43Z" },
        weekly: { status: "ok", percent: 62, resetsAt: "2026-10-20T00:00:00Z" },
        monthly: { status: "ok", percent: 12, resetsAt: "2026-11-01T00:00:00Z" },
      }),
      CAPTURED,
    );

    expect(snapshot.provider).toBe("opencode-go");
    expect(snapshot.windows.map((window) => [window.id, window.label, window.usedPercent])).toEqual([
      ["rolling", "ローリング", 35],
      ["weekly", "週次", 62],
      ["monthly", "月次", 12],
    ]);
    expect(snapshot.windows[0]?.resetsAt).toBe(Date.parse("2026-10-18T09:36:43Z"));
    expect(snapshot.plan).toBeNull();
    expect(snapshot.limitReached).toBe(false);
  });

  test("0.5% のような小数を百分率のまま扱う", () => {
    const snapshot = parseOpenCodeUsage(usage({ rolling: { status: "ok", percent: 0.5 } }), CAPTURED);

    expect(snapshot.windows[0]?.usedPercent).toBe(0.5);
  });

  test("resetsAt が ISO でなければリセット時刻不明として扱う", () => {
    const snapshot = parseOpenCodeUsage(
      usage({ rolling: { percent: 10, resetsAt: "not-a-date" }, weekly: { percent: 10, resetsAt: 12345 } }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => window.resetsAt)).toEqual([null, null]);
  });

  test("返らなかった窓は行を作らない", () => {
    const snapshot = parseOpenCodeUsage(
      usage({ rolling: { status: "ok", percent: 10 }, monthly: { status: "ok", percent: 90 } }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => window.id)).toEqual(["rolling", "monthly"]);
  });

  test("percent を読めない窓は落とす", () => {
    const snapshot = parseOpenCodeUsage(
      usage({ rolling: { status: "ok" }, weekly: { status: "ok", percent: "10" }, monthly: { percent: 0 } }),
      CAPTURED,
    );

    expect(snapshot.windows.map((window) => [window.id, window.usedPercent])).toEqual([["monthly", 0]]);
  });

  test("status が ok 以外なら上限到達として注記する", () => {
    const snapshot = parseOpenCodeUsage(
      usage({ rolling: { status: "exceeded", percent: 100 }, weekly: { status: "ok", percent: 10 } }),
      CAPTURED,
    );

    expect(snapshot.limitReached).toBe(true);
    expect(snapshot.notes).toEqual(["利用枠の状態が正常ではありません"]);
  });

  test("usage が無い / 窓が 1 つも無い応答は schema エラー", () => {
    expect(codeOf({})).toBe("schema");
    expect(codeOf({ usage: {} })).toBe("schema");
    expect(codeOf(usage({ rolling: null }))).toBe("schema");
    expect(codeOf(null)).toBe("schema");
  });

  test("100 を超えた percent は 100 に丸めて注記する", () => {
    const snapshot = parseOpenCodeUsage(usage({ weekly: { percent: 130 } }), CAPTURED);

    expect(snapshot.windows[0]?.usedPercent).toBe(100);
    expect(snapshot.notes).toContain("上限超過");
  });

  test("上流の生 JSON を snapshot に持ち込まない", () => {
    const snapshot = parseOpenCodeUsage(
      usage({ rolling: { status: "ok", percent: 10, account: "sentinel-account", key: "sentinel-key" } }),
      CAPTURED,
    );

    expect(JSON.stringify(snapshot)).not.toContain("sentinel");
  });
});

describe("fetchOpenCodeUsage", () => {
  test("キー未登録は上流へ出ず not_connected になる", async () => {
    const error: unknown = await fetchOpenCodeUsage({
      apiKey: null,
      userAgent: "usage-portal/test",
      now: () => CAPTURED,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("not_connected");
  });
});
