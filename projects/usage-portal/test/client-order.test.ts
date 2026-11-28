// 使い切ったカードは末尾へ回す。読む必要があるのは、まだ使えるカード。
import { describe, expect, test } from "bun:test";
import type { ProviderState, UsageSource, UsageWindow } from "../src/client/api";
import { isExhausted, orderSources } from "../src/client/lib/order";

function window(id: string, label: string, usedPercent: number): UsageWindow {
  return { id, label, durationSeconds: null, usedPercent, resetsAt: null };
}

function windows(rolling: number, weekly: number, monthly: number): UsageWindow[] {
  return [
    window("rolling", "ローリング", rolling),
    window("weekly", "週次", weekly),
    window("monthly", "月次", monthly),
  ];
}

function source(id: string, state: ProviderState, meters: UsageWindow[]): UsageSource {
  return {
    id,
    provider: id === "codex" ? "codex" : "opencode-go",
    name: id,
    plan: null,
    account: null,
    state,
    capturedAt: null,
    fetchIntervalMs: 600_000,
    nextFetchAt: null,
    error: null,
    limitReached: false,
    windows: meters,
    notes: [],
    resetCredits: null,
    claudeResetCredits: null,
    trends: [],
  };
}

describe("isExhausted", () => {
  test("全窓が 100% なら使い切っている", () => {
    expect(isExhausted(source("a", "ok", windows(100, 100, 100)))).toBe(true);
  });

  test("外側が尽きて内側が止まっていても使い切っている", () => {
    expect(isExhausted(source("a", "ok", windows(0, 40, 100)))).toBe(true);
  });

  test("1 つでも使える窓があれば使い切っていない", () => {
    expect(isExhausted(source("a", "ok", windows(100, 40, 40)))).toBe(false);
    expect(isExhausted(source("a", "ok", windows(0, 99, 99)))).toBe(false);
  });

  test("窓が無いカードは判断しない", () => {
    expect(isExhausted(source("a", "loading", []))).toBe(false);
    expect(isExhausted(source("a", "error", []))).toBe(false);
  });

  test("前回値を出しているカードは止まっていても判断する", () => {
    expect(isExhausted(source("a", "stale", windows(100, 100, 100)))).toBe(true);
  });
});

describe("orderSources", () => {
  test("使い切ったカードだけを末尾へ回し、それ以外は元の順を保つ", () => {
    const codex = source("codex", "ok", windows(40, 60, 80));
    const active = source("active", "ok", windows(100, 100, 100));
    const spare = source("spare", "ok", windows(10, 20, 30));
    const exhausted = source("exhausted", "ok", windows(0, 40, 100));

    expect(orderSources([codex, active, spare, exhausted]).map((item) => item.id)).toEqual([
      "codex",
      "spare",
      "active",
      "exhausted",
    ]);
  });

  test("OpenCode Go は月次の残りが多い順に並ぶ", () => {
    const least = source("least", "ok", windows(100, 100, 99));
    const most = source("most", "ok", windows(40, 60, 34));
    const middle = source("middle", "ok", windows(0, 30, 75));

    expect(orderSources([least, most, middle]).map((item) => item.id)).toEqual(["most", "middle", "least"]);
  });

  test("月次を持たない Codex は位置を変えない", () => {
    const codex = source("codex", "ok", [window("primary", "週次", 95)]);
    const least = source("least", "ok", windows(0, 10, 99));
    const most = source("most", "ok", windows(0, 10, 20));

    expect(orderSources([codex, least, most]).map((item) => item.id)).toEqual(["codex", "most", "least"]);
  });

  test("月次を読めないカードは位置を保つ", () => {
    const least = source("least", "ok", windows(0, 10, 99));
    const loading = source("loading", "loading", []);
    const most = source("most", "ok", windows(0, 10, 20));

    expect(orderSources([least, loading, most]).map((item) => item.id)).toEqual(["most", "loading", "least"]);
  });

  test("月次の窓だけが欠けたカードは位置を保つ", () => {
    const least = source("least", "ok", windows(0, 10, 99));
    const partial = source("partial", "ok", [window("rolling", "ローリング", 10), window("weekly", "週次", 20)]);
    const most = source("most", "ok", windows(0, 10, 20));

    expect(orderSources([least, partial, most]).map((item) => item.id)).toEqual(["most", "partial", "least"]);
  });

  test("取得前・取得失敗のカードは元の位置に残す", () => {
    const loading = source("loading", "loading", []);
    const exhausted = source("exhausted", "ok", windows(100, 100, 100));
    const failed = source("failed", "error", []);

    expect(orderSources([loading, exhausted, failed]).map((item) => item.id)).toEqual([
      "loading",
      "failed",
      "exhausted",
    ]);
  });

  test("空と、全部使い切った並びでも落ちない", () => {
    expect(orderSources([])).toEqual([]);
    expect(orderSources([source("a", "ok", windows(100, 100, 100))]).map((item) => item.id)).toEqual(["a"]);
  });
});
