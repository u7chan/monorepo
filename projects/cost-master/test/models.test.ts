import { describe, expect, test } from "bun:test";
import { groupByModel, sortGroups, summarize, withModelEnabled } from "../src/client/models";
import type { CostModelPrice } from "../src/shared/contract";

function price(overrides: Partial<CostModelPrice> = {}): CostModelPrice {
  return {
    provider: "openrouter",
    modelId: "vendor/a",
    billable: "output_image",
    unit: "image",
    variant: "",
    costUsd: 0.06,
    currency: "USD",
    enabled: true,
    note: null,
    ...overrides,
  };
}

describe("groupByModel", () => {
  test("同じモデルの行をまとめ、初出の順を保つ", () => {
    const groups = groupByModel([
      price({ modelId: "b" }),
      price({ modelId: "a", unit: "image" }),
      price({ modelId: "a", unit: "token", costUsd: 0.00003 }),
    ]);

    expect(groups.map((group) => group.modelId)).toEqual(["b", "a"]);
    expect(groups[1]?.prices.map((entry) => entry.unit)).toEqual(["image", "token"]);
  });

  test("単価は基本単価を先頭に、解像度の小さい順へ並べる", () => {
    const groups = groupByModel([
      price({ variant: "2k" }),
      price({ variant: "1.5k" }),
      price({ variant: "1k" }),
      price({ variant: "" }),
      price({ unit: "token", costUsd: 0.00003 }),
    ]);

    expect(groups[0]?.prices.map((entry) => entry.variant)).toEqual(["", "1k", "1.5k", "2k", ""]);
  });

  test("enabled と note はモデルの判断として 1 つだけ持つ", () => {
    const groups = groupByModel([price({ enabled: false, note: "高価" })]);

    expect(groups[0]).toMatchObject({ enabled: false, note: "高価" });
  });
});

describe("sortGroups", () => {
  test("名前順は modelId の昇順にする", () => {
    const groups = groupByModel([price({ modelId: "b" }), price({ modelId: "c" }), price({ modelId: "a" })]);

    expect(sortGroups(groups, "name").map((group) => group.modelId)).toEqual(["a", "b", "c"]);
  });

  test("単価順は同じ unit の中で安い順にし、基本単価を使う", () => {
    const groups = groupByModel([
      price({ modelId: "x", variant: "2k", costUsd: 0.2 }),
      price({ modelId: "x", variant: "", costUsd: 0.08 }),
      price({ modelId: "y", costUsd: 0.05 }),
      price({ modelId: "z", costUsd: 0.01 }),
    ]);

    expect(sortGroups(groups, "cost").map((group) => group.modelId)).toEqual(["z", "y", "x"]);
  });

  test("単位の違う単価は数値で比べず、image → megapixel → token → request の順に分ける", () => {
    const groups = groupByModel([
      price({ modelId: "request", unit: "request", costUsd: 0.02 }),
      price({ modelId: "token", unit: "token", costUsd: 0.000001 }),
      price({ modelId: "image", unit: "image", costUsd: 0.05 }),
      price({ modelId: "megapixel", unit: "megapixel", costUsd: 0.01 }),
    ]);

    expect(sortGroups(groups, "cost").map((group) => group.modelId)).toEqual([
      "image",
      "megapixel",
      "token",
      "request",
    ]);
  });

  test("同じ単価なら名前順にする", () => {
    const groups = groupByModel([price({ modelId: "b", costUsd: 0.05 }), price({ modelId: "a", costUsd: 0.05 })]);

    expect(sortGroups(groups, "cost").map((group) => group.modelId)).toEqual(["a", "b"]);
  });

  test("元の配列とグループを書き換えない", () => {
    const groups = groupByModel([price({ modelId: "b", costUsd: 0.05 }), price({ modelId: "a", costUsd: 0.01 })]);

    sortGroups(groups, "cost");

    expect(groups.map((group) => group.modelId)).toEqual(["b", "a"]);
  });
});

describe("summarize", () => {
  test("モデル数・行数・一覧に出さない件数を数える", () => {
    const summary = summarize([
      price({ modelId: "a", enabled: false }),
      price({ modelId: "a", unit: "token" }),
      price({ modelId: "b" }),
    ]);

    expect(summary).toEqual({ models: 2, rows: 3, hidden: 1 });
  });
});

describe("withModelEnabled", () => {
  const payload = {
    version: 3,
    fetchedAt: 1_794_600_000_000,
    models: [
      price({ modelId: "a", unit: "image", enabled: true }),
      price({ modelId: "a", unit: "token", enabled: true }),
      price({ modelId: "b", enabled: true }),
    ],
  };

  test("同じモデルの行すべてに反映し、他のモデルと世代は変えない", () => {
    const next = withModelEnabled(payload, "a", false);

    expect(next.models.filter((model) => model.modelId === "a").every((model) => !model.enabled)).toBe(true);
    expect(next.models.find((model) => model.modelId === "b")?.enabled).toBe(true);
    expect(next.version).toBe(payload.version);
    expect(next.fetchedAt).toBe(payload.fetchedAt);
  });

  test("元の payload を書き換えない", () => {
    withModelEnabled(payload, "a", false);

    expect(payload.models.every((model) => model.enabled)).toBe(true);
  });
});
