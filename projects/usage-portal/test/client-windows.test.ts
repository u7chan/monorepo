// 推移の初期表示は週次。窓は短い方が長い方に含まれ、外側が尽きたら内側は使えない。
import { describe, expect, test } from "bun:test";
import type { UsageWindow } from "../src/client/api";
import { arrangeWindowSlots, findBlockedWindows, isRolling, pickTrendWindow } from "../src/client/lib/windows";

function window(id: string, label: string, usedPercent = 10): UsageWindow {
  return { id, label, durationSeconds: null, usedPercent, resetsAt: null };
}

function threeWindows(rolling: number, weekly: number, monthly: number): UsageWindow[] {
  return [
    window("rolling", "ローリング", rolling),
    window("weekly", "週次", weekly),
    window("monthly", "月次", monthly),
  ];
}

function blockedLabels(windows: UsageWindow[]): Record<string, string> {
  return Object.fromEntries([...findBlockedWindows(windows)].map(([id, block]) => [id, block.byLabel]));
}

describe("pickTrendWindow", () => {
  test("Codex と OpenCode Go のどちらも週次を選ぶ", () => {
    expect(pickTrendWindow([window("primary", "ローリング"), window("secondary", "週次")])?.id).toBe("secondary");
    expect(
      pickTrendWindow([window("rolling", "ローリング"), window("weekly", "週次"), window("monthly", "月次")])?.id,
    ).toBe("weekly");
  });

  test("重複ラベルで第 N 枠が付いても週次を選ぶ", () => {
    expect(pickTrendWindow([window("primary", "ローリング"), window("secondary", "週次（第1枠）")])?.id).toBe(
      "secondary",
    );
  });

  test("週次が無ければ先頭、窓が無ければ null", () => {
    expect(pickTrendWindow([window("primary", "ローリング")])?.id).toBe("primary");
    expect(pickTrendWindow([])).toBeNull();
  });
});

describe("isRolling", () => {
  test("重複ラベルで第 N 枠が付いてもローリングと分かる", () => {
    expect(isRolling(window("rolling", "ローリング"))).toBe(true);
    expect(isRolling(window("rolling", "ローリング（第2枠）"))).toBe(true);
    expect(isRolling(window("weekly", "週次"))).toBe(false);
  });
});

describe("findBlockedWindows", () => {
  test("月次が上限なら、残っていても週次とローリングを使えなくする", () => {
    expect(blockedLabels(threeWindows(10, 20, 100))).toEqual({
      rolling: "月次",
      weekly: "月次",
    });
  });

  test("週次が上限ならローリングだけを使えなくする", () => {
    expect(blockedLabels(threeWindows(10, 100, 40))).toEqual({ rolling: "週次" });
  });

  test("複数の外側が上限なら、いつ戻るかを決める最も外側を理由にする", () => {
    expect(blockedLabels(threeWindows(10, 100, 100))).toEqual({
      rolling: "月次",
      weekly: "月次",
    });
  });

  test("100% の窓が無ければ止めない", () => {
    expect(blockedLabels(threeWindows(10, 20, 30))).toEqual({});
    expect(blockedLabels(threeWindows(99.9, 99.9, 99.9))).toEqual({});
  });

  test("内側の窓が上限でも、外側の窓は止めない", () => {
    expect(blockedLabels(threeWindows(100, 20, 30))).toEqual({});
  });

  test("Codex の 2 窓でも同じ規則を使う", () => {
    expect(blockedLabels([window("primary", "ローリング", 30), window("secondary", "週次", 100)])).toEqual({
      primary: "週次",
    });
  });

  test("期間の分からないラベルは比較に参加させない", () => {
    expect(blockedLabels([window("primary", "不明", 10), window("secondary", "月次", 100)])).toEqual({});
    expect(blockedLabels([window("primary", "月次", 100), window("secondary", "不明", 10)])).toEqual({});
  });
});

describe("arrangeWindowSlots", () => {
  test("Codex は 5 時間枠が返らなくても、その場所を空きスロットとして残す", () => {
    const weekly = window("secondary", "週次", 76);

    expect(arrangeWindowSlots("codex", [weekly])).toEqual([
      { label: "ローリング", absentNote: "5 時間枠は提供されていません" },
      { window: weekly },
    ]);
  });

  test("Codex の 2 窓は API の順ではなくローリング・週次の順に並べる", () => {
    const rolling = window("primary", "ローリング", 10);
    const weekly = window("secondary", "週次", 20);

    expect(arrangeWindowSlots("codex", [weekly, rolling])).toEqual([{ window: rolling }, { window: weekly }]);
  });

  test("定義の無い provider と空の一覧はそのまま返す", () => {
    const windows = threeWindows(10, 20, 30);

    expect(arrangeWindowSlots("opencode-go", windows)).toEqual(windows.map((window) => ({ window })));
    expect(arrangeWindowSlots("codex", [])).toEqual([]);
  });

  test("定義に無い窓は落とさず、末尾に出す", () => {
    const weekly = window("secondary", "週次", 76);
    const extra = window("other", "不明", 5);

    expect(arrangeWindowSlots("codex", [weekly, extra])).toEqual([
      { label: "ローリング", absentNote: "5 時間枠は提供されていません" },
      { window: weekly },
      { window: extra },
    ]);
  });
});
