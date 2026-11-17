import { describe, expect, test } from "bun:test";
import { groupByModel, summarize, withModelEnabled } from "../src/client/models";
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
