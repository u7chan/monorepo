import { describe, expect, test } from "bun:test";
import { buildPayload, parseJudgmentFile, parsePriceFile, planJudgment, type PriceRow } from "../src/server/master";

const ROW: PriceRow = {
  modelId: "krea/krea-2-large",
  kind: "image",
  billable: "output_image",
  unit: "image",
  variant: "",
  costUsd: 0.06,
};

function priceFile(models: unknown[]): unknown {
  return { version: 3, fetchedAt: 1_794_600_000_000, models };
}

describe("parsePriceFile", () => {
  test("トップレベルの形が違うと「読めない」として失敗する", () => {
    expect(parsePriceFile(null)).toEqual({ ok: false, reason: "shape" });
    expect(parsePriceFile({ version: -1, fetchedAt: 1, models: [] })).toEqual({ ok: false, reason: "version" });
    expect(parsePriceFile({ version: 1, fetchedAt: 0, models: [] })).toEqual({ ok: false, reason: "fetchedAt" });
    expect(parsePriceFile({ version: 1, fetchedAt: 1, models: {} })).toEqual({ ok: false, reason: "models" });
  });

  test("正しいファイルは世代・取得時刻・行を返す", () => {
    const parsed = parsePriceFile(priceFile([ROW]));

    expect(parsed).toEqual({
      ok: true,
      version: 3,
      fetchedAt: 1_794_600_000_000,
      rows: [ROW],
      dropped: [],
    });
  });

  test("許可外の billable・未知 unit・負や非数値の単価・空の modelId を落とす", () => {
    const parsed = parsePriceFile(
      priceFile([
        { ...ROW, billable: "input_image" },
        { ...ROW, billable: "output_video" },
        { ...ROW, unit: "second" },
        { ...ROW, costUsd: -0.01 },
        { ...ROW, costUsd: "0.06" },
        { ...ROW, modelId: "" },
        { ...ROW, variant: 768 },
        null,
      ]),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rows).toEqual([]);
    expect(parsed.ok && parsed.dropped.map((entry) => entry.reason)).toEqual([
      "billable",
      "billable",
      "unit",
      "cost",
      "cost",
      "model-id",
      "variant",
      "shape",
    ]);
  });

  test("音声の入力・出力の行を受け付ける", () => {
    const parsed = parsePriceFile(
      priceFile([
        { modelId: "tts/a", kind: "speech", billable: "input_text", unit: "character", variant: "", costUsd: 0.000015 },
        { modelId: "tts/a", kind: "speech", billable: "output_audio", unit: "minute", variant: "", costUsd: 0.15 },
      ]),
    );

    expect(parsed.ok && parsed.rows).toEqual([
      { modelId: "tts/a", kind: "speech", billable: "input_text", unit: "character", variant: "", costUsd: 0.000015 },
      { modelId: "tts/a", kind: "speech", billable: "output_audio", unit: "minute", variant: "", costUsd: 0.15 },
    ]);
  });

  test("kind が無い・未知の行と、同じモデルで kind が食い違う行を落とす", () => {
    const { kind: _kind, ...withoutKind } = ROW;
    const parsed = parsePriceFile(
      priceFile([
        ROW,
        { ...ROW, kind: "speech", billable: "input_text", unit: "character", costUsd: 0.00001 },
        withoutKind,
        { ...ROW, kind: "video" },
      ]),
    );

    expect(parsed.ok && parsed.rows).toEqual([ROW]);
    expect(parsed.ok && parsed.dropped.map((entry) => entry.reason)).toEqual(["kind", "kind", "kind"]);
  });

  test("宣言された 0 は無料として残す（不明と区別する）", () => {
    const parsed = parsePriceFile(priceFile([{ ...ROW, costUsd: 0 }]));

    expect(parsed.ok && parsed.rows).toEqual([{ ...ROW, costUsd: 0 }]);
  });

  test("variant が無い行は空文字として読む", () => {
    const { variant: _variant, ...withoutVariant } = ROW;
    const parsed = parsePriceFile(priceFile([withoutVariant]));

    expect(parsed.ok && parsed.rows).toEqual([ROW]);
  });

  test("同じ請求単位が重複したら後の行を落とす", () => {
    const parsed = parsePriceFile(priceFile([ROW, { ...ROW, costUsd: 0.07 }]));

    expect(parsed.ok && parsed.rows).toEqual([ROW]);
    expect(parsed.ok && parsed.dropped).toEqual([{ modelId: ROW.modelId, reason: "duplicate" }]);
  });
});

describe("parseJudgmentFile", () => {
  test("判断が無ければ空（既定は「一覧に出す」）", () => {
    const parsed = parseJudgmentFile({ models: [] });

    expect(parsed.ok && parsed.rows.size).toBe(0);
  });

  test("ファイル全体が読めないときは失敗にする（全部表示へ黙って倒さない）", () => {
    expect(parseJudgmentFile(undefined)).toEqual({ ok: false, reason: "shape" });
    expect(parseJudgmentFile({ models: {} })).toEqual({ ok: false, reason: "models" });
  });

  test("enabled と note を読む。note が空文字なら持たない", () => {
    const parsed = parseJudgmentFile({
      models: [
        { modelId: "a", enabled: false, note: "高価" },
        { modelId: "b", enabled: true, note: "" },
      ],
    });

    expect(parsed.ok && parsed.rows.get("a")).toEqual({ modelId: "a", enabled: false, note: "高価" });
    expect(parsed.ok && parsed.rows.get("b")).toEqual({ modelId: "b", enabled: true });
    expect(parsed.ok && parsed.dropped).toEqual([]);
  });

  test("型が違う行を落とす", () => {
    const parsed = parseJudgmentFile({
      models: [
        { modelId: "a", enabled: "false" },
        { modelId: "", enabled: false },
        { modelId: "b", enabled: true, note: 1 },
      ],
    });

    expect(parsed.ok && parsed.rows.size).toBe(0);
    expect(parsed.ok && parsed.dropped.map((entry) => entry.reason)).toEqual(["enabled", "model-id", "note"]);
  });

  test("同じモデルで enabled が食い違ったら両方落とす（隠す判断を誤って適用しない）", () => {
    const parsed = parseJudgmentFile({
      models: [
        { modelId: "a", enabled: false },
        { modelId: "a", enabled: true },
        { modelId: "a", enabled: false },
      ],
    });

    expect(parsed.ok && parsed.rows.size).toBe(0);
    expect(parsed.ok && parsed.dropped).toEqual([{ modelId: "a", reason: "conflict" }]);
  });

  test("同じモデルの同じ enabled は 1 つに畳み、重複として記録する（アップロードでは拒否する）", () => {
    const parsed = parseJudgmentFile({
      models: [
        { modelId: "a", enabled: false, note: "1 枚 $0.06" },
        { modelId: "a", enabled: false },
      ],
    });

    expect(parsed.ok && parsed.rows.get("a")).toEqual({ modelId: "a", enabled: false, note: "1 枚 $0.06" });
    expect(parsed.ok && parsed.dropped).toEqual([{ modelId: "a", reason: "duplicate" }]);
  });
});

describe("buildPayload", () => {
  const rows: PriceRow[] = [
    { ...ROW, unit: "token", variant: "", costUsd: 0.00003 },
    { ...ROW, unit: "image", variant: "2k", costUsd: 0.1 },
    { ...ROW, unit: "image", variant: "", costUsd: 0.06 },
  ];

  test("判断が無いモデルは enabled: true / note: null", () => {
    const payload = buildPayload({ version: 1, fetchedAt: 10, rows: [ROW], judgments: new Map() });

    expect(payload.models).toEqual([
      {
        provider: "openrouter",
        modelId: ROW.modelId,
        kind: "image",
        billable: "output_image",
        unit: "image",
        variant: "",
        costUsd: 0.06,
        currency: "USD",
        enabled: true,
        note: null,
      },
    ]);
  });

  test("判断を重ね、モデル・unit・variant の順に並べる（基本単価が先）", () => {
    const payload = buildPayload({
      version: 1,
      fetchedAt: 10,
      rows,
      judgments: new Map([[ROW.modelId, { modelId: ROW.modelId, enabled: false, note: "高価" }]]),
    });

    expect(payload.models.map((model) => `${model.unit}:${model.variant}`)).toEqual(["image:", "image:2k", "token:"]);
    expect(payload.models.every((model) => !model.enabled && model.note === "高価")).toBe(true);
  });
});

describe("planJudgment", () => {
  test("行が無ければ末尾に足す", () => {
    const plan = planJudgment({ models: [{ modelId: "b", enabled: false }] }, "a", false);

    expect(plan).not.toBeNull();
    expect(plan?.changed).toBe(true);
    expect(plan?.changed && JSON.parse(plan.text)).toEqual({
      models: [
        { modelId: "b", enabled: false },
        { modelId: "a", enabled: false },
      ],
    });
  });

  test("既存行は enabled だけ変え、note・未知のキー・位置を保つ", () => {
    const plan = planJudgment(
      {
        models: [
          { modelId: "a", enabled: false, note: "高価", why: "計測" },
          { modelId: "b", enabled: false },
        ],
      },
      "a",
      true,
    );

    expect(plan?.changed).toBe(true);
    expect(plan?.changed && JSON.parse(plan.text)).toEqual({
      models: [
        { modelId: "a", enabled: true, note: "高価", why: "計測" },
        { modelId: "b", enabled: false },
      ],
    });
  });

  test("有効値が要求値と同じなら changed: false（行が無いモデルへの true も同じ）", () => {
    expect(planJudgment({ models: [{ modelId: "a", enabled: true }] }, "a", true)).toEqual({ changed: false });
    expect(planJudgment({ models: [] }, "a", true)).toEqual({ changed: false });
  });

  test("ルートがオブジェクトでない・models が配列でない入力は null", () => {
    for (const value of [null, [], "x", { models: {} }, { models: "x" }]) {
      expect(planJudgment(value, "a", false)).toBeNull();
    }
  });

  test("トップレベルの未知のキーも残す", () => {
    const plan = planJudgment({ models: [], generatedBy: "x" }, "a", false);

    expect(plan?.changed && JSON.parse(plan.text)).toEqual({
      models: [{ modelId: "a", enabled: false }],
      generatedBy: "x",
    });
  });
});
