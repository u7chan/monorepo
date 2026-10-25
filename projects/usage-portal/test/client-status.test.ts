// 状態ラベルの優先順位と、色に頼らない記号を固定する。
import { describe, expect, test } from "bun:test";
import { deriveProviderStatus, type StatusInput } from "../src/client/lib/status";

function status(overrides: Partial<StatusInput> = {}) {
  return deriveProviderStatus({
    id: "codex",
    state: "ok",
    errorCode: null,
    limitReached: false,
    usedPercents: [10],
    ...overrides,
  });
}

describe("deriveProviderStatus", () => {
  test("80% 未満は利用可能", () => {
    expect(status({ usedPercents: [0, 79] })).toEqual({ label: "利用可能", tone: "success", symbol: "●" });
  });

  test("80% 以上は残りわずか（注意の記号付き）", () => {
    expect(status({ usedPercents: [10, 80] })).toEqual({ label: "残りわずか", tone: "attention", symbol: "▲" });
  });

  test("上限到達は 100% でも limitReached でも同じラベル", () => {
    expect(status({ usedPercents: [100] }).label).toBe("上限到達");
    expect(status({ usedPercents: [10], limitReached: true }).label).toBe("上限到達");
  });

  test("取得中・更新停止・取得エラーを区別する", () => {
    expect(status({ state: "loading", usedPercents: [] }).label).toBe("取得中");
    expect(status({ state: "loading", usedPercents: [] }).tone).toBe("neutral");
    expect(status({ state: "stale" }).label).toBe("更新停止");
    expect(status({ state: "stale" }).symbol).toBe("▲");
    expect(status({ state: "error", usedPercents: [] }).label).toBe("取得エラー");
    expect(status({ state: "error", usedPercents: [] }).symbol).toBe("■");
  });

  test("Codex の未接続と再サインインは state より先に見る", () => {
    expect(status({ state: "error", errorCode: "not_connected", usedPercents: [] })).toEqual({
      label: "未接続",
      tone: "neutral",
      symbol: "○",
    });
    expect(status({ state: "error", errorCode: "reauth_required", usedPercents: [] })).toEqual({
      label: "再サインイン",
      tone: "attention",
      symbol: "▲",
    });
  });

  test("OpenCode Go の config エラーは取得エラーとして出す", () => {
    expect(status({ id: "opencode-go", state: "error", errorCode: "config", usedPercents: [] }).label).toBe(
      "取得エラー",
    );
  });
});
