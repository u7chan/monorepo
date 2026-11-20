import { describe, expect, test } from "bun:test";
import {
  countByKind,
  filterByKind,
  groupByModel,
  priceKey,
  sideOf,
  sortGroups,
  splitModelId,
  summarize,
  withModelEnabled,
} from "../src/client/models";
import type { CostModelPrice } from "../src/shared/contract";

function price(overrides: Partial<CostModelPrice> = {}): CostModelPrice {
  return {
    provider: "openrouter",
    modelId: "vendor/a",
    kind: "image",
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

describe("priceKey", () => {
  test("入力と出力は別の行として区別する", () => {
    const input = price({ modelId: "tts/a", billable: "input_text", unit: "token" });
    const output = price({ modelId: "tts/a", billable: "output_audio", unit: "token" });

    expect(sideOf(input)).toBe("input");
    expect(sideOf(output)).toBe("output");
    expect(priceKey(input)).not.toBe(priceKey(output));
  });
});

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

describe("filterByKind", () => {
  test("モデルの種類で絞り、all は全部を返す", () => {
    const rows = [
      price({ modelId: "img/a" }),
      price({ modelId: "tts/a", kind: "speech", billable: "input_text", unit: "character", costUsd: 0.000015 }),
    ];

    expect(filterByKind(rows, "image").map((row) => row.modelId)).toEqual(["img/a"]);
    expect(filterByKind(rows, "speech").map((row) => row.modelId)).toEqual(["tts/a"]);
    expect(filterByKind(rows, "all")).toHaveLength(2);
  });

  test("元の配列を書き換えない", () => {
    const rows = [price({ modelId: "a" })];

    filterByKind(rows, "all").pop();

    expect(rows).toHaveLength(1);
  });
});

describe("countByKind", () => {
  test("行ではなくモデルを数える", () => {
    const groups = groupByModel([
      price({ modelId: "img/a" }),
      price({ modelId: "tts/a", kind: "speech", billable: "input_text", unit: "token" }),
      price({ modelId: "tts/a", kind: "speech", billable: "output_audio", unit: "token" }),
    ]);

    expect(countByKind(groups)).toEqual({ all: 2, image: 1, speech: 1 });
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

describe("sortGroups の単価順", () => {
  test("種類 → 単位 → 単価の順。種類をまたいで混ぜない", () => {
    const groups = groupByModel([
      price({ modelId: "tts/cheap", kind: "speech", billable: "input_text", unit: "character", costUsd: 0.000001 }),
      price({ modelId: "img/expensive", unit: "image", costUsd: 0.5 }),
      price({ modelId: "img/cheap", unit: "image", costUsd: 0.01 }),
      price({ modelId: "img/per-token", unit: "token", costUsd: 0.0000001 }),
    ]);

    expect(sortGroups(groups, "cost").map((group) => group.modelId)).toEqual([
      "img/cheap",
      "img/expensive",
      "img/per-token",
      "tts/cheap",
    ]);
  });
});

describe("splitModelId", () => {
  test("先頭の / で提供元と名前に分ける", () => {
    expect(splitModelId("black-forest-labs/flux-3-image")).toEqual({
      provider: "black-forest-labs",
      name: "flux-3-image",
    });
  });

  test("名前に / を含んでも 2 つ目以降は名前に残す", () => {
    expect(splitModelId("vendor/family/model")).toEqual({ provider: "vendor", name: "family/model" });
  });

  test("/ が無い・端にある id は全体を名前にする", () => {
    expect(splitModelId("standalone")).toEqual({ provider: "", name: "standalone" });
    expect(splitModelId("/leading")).toEqual({ provider: "", name: "/leading" });
    expect(splitModelId("trailing/")).toEqual({ provider: "", name: "trailing/" });
  });
});
