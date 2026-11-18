// Claude の更新応答と、provider: claude の source を画面側で解釈できることを固定する。
import { describe, expect, test } from "bun:test";
import { parseClaudeRefresh, parseUsage } from "../src/client/api";

describe("parseClaudeRefresh", () => {
  test("refreshed / skipped の理由 / failed のコードだけを受け取る", () => {
    expect(parseClaudeRefresh({ state: "refreshed" })).toEqual({ state: "refreshed" });
    expect(parseClaudeRefresh({ state: "skipped", reason: "fresh" })).toEqual({ state: "skipped", reason: "fresh" });
    expect(parseClaudeRefresh({ state: "skipped", reason: "cooldown" })).toEqual({
      state: "skipped",
      reason: "cooldown",
    });
    expect(parseClaudeRefresh({ state: "failed", error: "not_connected" })).toEqual({
      state: "failed",
      error: "not_connected",
    });
  });

  test("知らない状態・理由は捨て、コードの無い失敗は unavailable にする", () => {
    expect(parseClaudeRefresh({ state: "skipped", reason: "later" })).toBeNull();
    expect(parseClaudeRefresh({ state: "unknown" })).toBeNull();
    expect(parseClaudeRefresh(null)).toBeNull();
    expect(parseClaudeRefresh({ state: "failed" })).toEqual({ state: "failed", error: "unavailable" });
  });
});

describe("parseUsage", () => {
  test("provider: claude の source を読み、次回取得が無くても落とさない", () => {
    const payload = parseUsage({
      generatedAt: 1,
      sources: [
        {
          id: "claude",
          provider: "claude",
          name: "Claude",
          plan: "Max",
          account: null,
          state: "ok",
          capturedAt: 1,
          fetchIntervalMs: 900_000,
          nextFetchAt: null,
          error: null,
          limitReached: false,
          windows: [{ id: "rolling", label: "ローリング", durationSeconds: 18_000, usedPercent: 12, resetsAt: null }],
          notes: [],
          trends: [],
        },
      ],
    });

    expect(payload?.sources).toHaveLength(1);
    expect(payload?.sources[0]?.provider).toBe("claude");
    expect(payload?.sources[0]?.plan).toBe("Max");
    expect(payload?.sources[0]?.nextFetchAt).toBeNull();
  });
});
