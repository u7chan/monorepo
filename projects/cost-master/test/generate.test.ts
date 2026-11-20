import { describe, expect, test } from "bun:test";
import { generatePrices, type GenerateResult } from "../src/server/generate";
import type { PriceMasterFile, PriceRow } from "../src/server/master";

const LIST = "/api/v1/images/models";
const ENDPOINTS = (id: string): string => `${LIST}/${id}/endpoints`;
const NOW = 1_794_600_000_000;

function json(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname;
    const handler = routes[path];

    if (handler === undefined) {
      throw new Error(`unexpected fetch: ${path}`);
    }

    return handler();
  }) as unknown as typeof fetch;
}

function run(routes: Record<string, () => Response>, previous: PriceMasterFile | null = null): Promise<GenerateResult> {
  return generatePrices({ fetchImpl: stubFetch(routes), previous, now: () => NOW, speech: false });
}

function ok(result: GenerateResult): Extract<GenerateResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.reason}`);
  }

  return result;
}

describe("generatePrices", () => {
  test("出力側だけを写し、同じ請求単位は最大単価に潰し、endpoints が空なら行を作らない", async () => {
    const result = ok(
      await run({
        [LIST]: json({
          data: [
            { id: "vendor/a", endpoints: ENDPOINTS("vendor/a") },
            { id: "vendor/b", endpoints: ENDPOINTS("vendor/b") },
          ],
        }),
        [ENDPOINTS("vendor/a")]: json({
          id: "vendor/a",
          endpoints: [
            { pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.01 }] },
            {
              pricing: [
                { billable: "output_image", unit: "image", cost_usd: 0.02 },
                { billable: "input_image", unit: "image", cost_usd: 0.5 },
                { billable: "output_image", unit: "second", cost_usd: 0.9 },
              ],
            },
          ],
        }),
        [ENDPOINTS("vendor/b")]: json({ id: "vendor/b", endpoints: [] }),
      }),
    );

    expect(result.file.models).toEqual([
      { modelId: "vendor/a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0.02 },
    ]);
    expect(result.file.version).toBe(1);
    expect(result.file.fetchedAt).toBe(NOW);
    expect(result.summary).toMatchObject({ models: 2, priced: 1, noPrice: 1, failed: [], rows: 1, changed: true });
  });

  test("variant を落とさず、宣言が無ければ空文字にする", async () => {
    const result = ok(
      await run({
        [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
        [ENDPOINTS("a")]: json({
          endpoints: [
            {
              pricing: [
                { billable: "output_image", unit: "image", cost_usd: 0.041, variant: "768" },
                { billable: "output_image", unit: "image", cost_usd: 0.607, variant: "4k" },
                { billable: "output_image", unit: "image", cost_usd: 0.03 },
              ],
            },
          ],
        }),
      }),
    );

    expect(result.file.models.map((row) => row.variant)).toEqual(["", "4k", "768"]);
  });

  test("価格未宣言・不正な行は 0 にせず落とし、宣言された 0 は残す", async () => {
    const result = ok(
      await run({
        [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
        [ENDPOINTS("a")]: json({
          endpoints: [
            {
              pricing: [
                { billable: "output_image", unit: "image", cost_usd: 0 },
                { billable: "output_image", unit: "image", cost_usd: -1 },
                { billable: "output_image", unit: "image", cost_usd: "0.02" },
                { billable: "output_image", unit: "second", cost_usd: 0.02 },
              ],
            },
            { pricing: [] },
          ],
        }),
      }),
    );

    expect(result.file.models).toEqual([
      { modelId: "a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0 },
    ]);
  });

  test("pricing が配列でない契約外応答は失敗として前回の行を残す（価格なしを確定しない）", async () => {
    const previous: PriceMasterFile = {
      version: 2,
      fetchedAt: 1,
      models: [{ modelId: "a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0.03 }],
    };

    for (const endpoints of [[{ prices: [] }], [{}], ["nope"]]) {
      const result = ok(
        await run(
          {
            [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
            [ENDPOINTS("a")]: json({ endpoints }),
          },
          previous,
        ),
      );

      expect(result.file.models).toEqual(previous.models);
      expect(result.file.version).toBe(2);
      expect(result.summary.failed).toEqual(["a"]);
    }
  });

  test("取得に失敗したモデルは前回の行を残す", async () => {
    const previous: PriceMasterFile = {
      version: 2,
      fetchedAt: 1,
      models: [{ modelId: "a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0.03 }],
    };
    const result = ok(
      await run(
        {
          [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
          [ENDPOINTS("a")]: () => new Response("upstream boom", { status: 500 }),
        },
        previous,
      ),
    );

    expect(result.file.models).toEqual(previous.models);
    expect(result.file.version).toBe(2);
    expect(result.summary.failed).toEqual(["a"]);
    expect(result.summary.changed).toBe(false);
  });

  test("endpoints が空になったモデルは前回の行を残さない（価格なしを確定する）", async () => {
    const previous: PriceMasterFile = {
      version: 2,
      fetchedAt: 1,
      models: [{ modelId: "a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0.03 }],
    };
    const result = ok(
      await run(
        {
          [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
          [ENDPOINTS("a")]: json({ id: "a", endpoints: [] }),
        },
        previous,
      ),
    );

    expect(result.file.models).toEqual([]);
    expect(result.file.version).toBe(3);
    expect(result.summary.diff.removed).toHaveLength(1);
  });

  test("一覧を取れないときは失敗し、ファイルを組み立てない", async () => {
    expect(await run({ [LIST]: () => new Response("boom", { status: 503 }) })).toEqual({
      ok: false,
      reason: "list_failed",
    });
    expect(await run({ [LIST]: json({ data: "nope" }) })).toEqual({ ok: false, reason: "list_shape" });
  });

  test("価格が変わらなければ version を進めず、fetchedAt だけ更新する", async () => {
    const routes = {
      [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
      [ENDPOINTS("a")]: json({
        endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.02 }] }],
      }),
    };
    const previous: PriceMasterFile = {
      version: 7,
      fetchedAt: 1,
      models: [{ modelId: "a", kind: "image", billable: "output_image", unit: "image", variant: "", costUsd: 0.02 }],
    };
    const result = ok(await run(routes, previous));

    expect(result.file.version).toBe(7);
    expect(result.file.fetchedAt).toBe(NOW);
    expect(result.summary.changed).toBe(false);
    expect(result.summary.diff).toEqual({ added: [], removed: [], changed: [] });
  });

  test("失敗の理由に上流の本文を含めない", async () => {
    const secret = "SECRET_UPSTREAM_BODY";
    const result = await run({
      [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
      [ENDPOINTS("a")]: () => new Response(secret, { status: 500 }),
    });

    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("単価が変わった行を差分として返す", async () => {
    const previousRow: PriceRow = {
      modelId: "a",
      kind: "image",
      billable: "output_image",
      unit: "image",
      variant: "",
      costUsd: 0.02,
    };
    const previous: PriceMasterFile = { version: 4, fetchedAt: 1, models: [previousRow] };
    const result = ok(
      await run(
        {
          [LIST]: json({ data: [{ id: "a", endpoints: ENDPOINTS("a") }] }),
          [ENDPOINTS("a")]: json({
            endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.03 }] }],
          }),
        },
        previous,
      ),
    );

    expect(result.file.version).toBe(5);
    expect(result.summary.diff.changed).toEqual([{ before: previousRow, after: { ...previousRow, costUsd: 0.03 } }]);
  });
});
