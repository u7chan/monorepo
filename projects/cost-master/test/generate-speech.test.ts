import { describe, expect, test } from "bun:test";
import { generateSpeechPrices, type SpeechGenerateResult } from "../src/server/generate-speech";
import type { PriceRow } from "../src/server/master";

const LIST = "/api/v1/models?output_modalities=speech";
const ENDPOINTS = (id: string): string => `/api/v1/models/${id}/endpoints`;
const UNITS = (id: string): string => `/${id}/llms.txt`;

function json(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function text(body: string, status = 200): () => Response {
  return () => new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${url.pathname}${url.search}`;
    const handler = routes[key];

    if (handler === undefined) {
      throw new Error(`unexpected fetch: ${key}`);
    }

    return handler();
  }) as unknown as typeof fetch;
}

function list(...ids: string[]): () => Response {
  return json({ data: ids.map((id) => ({ id })) });
}

function units(pricing: string): string {
  return `# TTS\n\n## Pricing\n\nStandard-variant prices for the model.\n\n${pricing}\n\n## EU in-region routing\n`;
}

function endpoints(prices: { prompt: string; completion?: string }[]): () => Response {
  return json({
    data: {
      id: "tts/a",
      endpoints: prices.map((price) => ({
        pricing: { prompt: price.prompt, completion: price.completion ?? "0", discount: 0 },
      })),
    },
  });
}

function run(routes: Record<string, () => Response>, previous: PriceRow[] = []): Promise<SpeechGenerateResult> {
  return generateSpeechPrices({
    fetchImpl: stubFetch(routes),
    origin: "https://openrouter.ai",
    previous,
    maxConcurrency: 2,
  });
}

describe("generateSpeechPrices", () => {
  test("文字建ては最大の provider 単価を採り、入力の行にする", async () => {
    const result = await run({
      [LIST]: list("tts/a"),
      [ENDPOINTS("tts/a")]: endpoints([{ prompt: "0.000015" }, { prompt: "0.00002" }]),
      [UNITS("tts/a")]: text(units("- Provider A: $15/M characters\n- Provider B: $20/M characters")),
    });

    expect(result.ok && result.rows).toEqual([
      { modelId: "tts/a", billable: "input_text", unit: "character", variant: "", costUsd: 0.00002 },
    ]);
    expect(result.ok && result.summary).toEqual({
      models: 1,
      priced: 1,
      unpriced: [],
      failed: [],
      rows: 1,
    });
  });

  test("バイト建て・トークン建て（入力と出力）・分建てを組み立てる", async () => {
    const result = await run({
      [LIST]: list("tts/bytes", "tts/tokens", "tts/minute"),
      [ENDPOINTS("tts/bytes")]: endpoints([{ prompt: "0.00001" }]),
      [UNITS("tts/bytes")]: text(units("- Fish Audio: $10/M UTF-8 bytes")),
      [ENDPOINTS("tts/tokens")]: endpoints([{ prompt: "0.0000005", completion: "0.000009" }]),
      [UNITS("tts/tokens")]: text(units("- Google: $0.50/M tokens input, $9/M tokens output")),
      [ENDPOINTS("tts/minute")]: endpoints([{ prompt: "0", completion: "0.0025" }]),
      [UNITS("tts/minute")]: text(units("- Seed: $0.15/minute")),
    });

    expect(result.ok && result.rows).toEqual([
      { modelId: "tts/bytes", billable: "input_text", unit: "byte", variant: "", costUsd: 0.00001 },
      { modelId: "tts/tokens", billable: "input_text", unit: "token", variant: "", costUsd: 0.0000005 },
      { modelId: "tts/tokens", billable: "output_audio", unit: "token", variant: "", costUsd: 0.000009 },
      { modelId: "tts/minute", billable: "output_audio", unit: "minute", variant: "", costUsd: 0.15 },
    ]);
  });

  test("分建ての検算が合わなければ失敗し、前回の行を残す", async () => {
    const previous: PriceRow[] = [
      { modelId: "tts/minute", billable: "output_audio", unit: "minute", variant: "", costUsd: 0.2 },
    ];
    const result = await run(
      {
        [LIST]: list("tts/minute"),
        [ENDPOINTS("tts/minute")]: endpoints([{ prompt: "0", completion: "0.00025" }]),
        [UNITS("tts/minute")]: text(units("- Seed: $0.15/minute")),
      },
      previous,
    );

    expect(result.ok && result.rows).toEqual(previous);
    expect(result.ok && result.summary.failed).toEqual(["tts/minute"]);
  });

  test("公開 endpoint がないモデルは行を作らず、前回の行も落とす", async () => {
    const previous: PriceRow[] = [
      { modelId: "tts/free", billable: "input_text", unit: "character", variant: "", costUsd: 0.00001 },
    ];
    const result = await run(
      {
        [LIST]: list("tts/free"),
        [ENDPOINTS("tts/free")]: endpoints([{ prompt: "0" }]),
        [UNITS("tts/free")]: text(
          "# TTS\n\n## Pricing\n\n`tts/free` has no public standard endpoint right now, so no current price is listed.\n\n## EU\n",
        ),
      },
      previous,
    );

    expect(result.ok && result.rows).toEqual([]);
    expect(result.ok && result.summary.unpriced).toEqual(["tts/free"]);
  });

  test("pricing を持たない endpoint は行だけ捨て、他の endpoint の単価を使う", async () => {
    const result = await run({
      [LIST]: list("tts/a"),
      [ENDPOINTS("tts/a")]: json({
        data: {
          endpoints: [{ pricing: { prompt: "0.000015", completion: "0" } }, { provider_name: "Broken" }],
        },
      }),
      [UNITS("tts/a")]: text(units("- Provider A: $15/M characters")),
    });

    expect(result.ok && result.rows).toEqual([
      { modelId: "tts/a", billable: "input_text", unit: "character", variant: "", costUsd: 0.000015 },
    ]);
  });

  test("公開 endpoint なしの宣言は endpoints の取得失敗より先に確定する", async () => {
    const previous: PriceRow[] = [
      { modelId: "tts/free", billable: "input_text", unit: "character", variant: "", costUsd: 0.00001 },
    ];
    const result = await run(
      {
        [LIST]: list("tts/free"),
        // endpoints は引けないが、llms.txt が「公開 endpoint なし」と宣言している
        [UNITS("tts/free")]: text(
          "# TTS\n\n## Pricing\n\n`tts/free` has no public standard endpoint right now, so no current price is listed.\n\n## EU\n",
        ),
      },
      previous,
    );

    expect(result.ok && result.rows).toEqual([]);
    expect(result.ok && result.summary.unpriced).toEqual(["tts/free"]);
  });

  test("llms.txt が読めないモデルは失敗として前回の行を残す", async () => {
    const previous: PriceRow[] = [
      { modelId: "tts/a", billable: "input_text", unit: "character", variant: "", costUsd: 0.00001 },
    ];
    const result = await run(
      {
        [LIST]: list("tts/a"),
        [ENDPOINTS("tts/a")]: endpoints([{ prompt: "0.00002" }]),
      },
      previous,
    );

    expect(result.ok && result.rows).toEqual(previous);
    expect(result.ok && result.summary.failed).toEqual(["tts/a"]);
  });

  test("未知の単位語・単位種の混在・endpoint の欠落は失敗にする", async () => {
    const result = await run({
      [LIST]: list("tts/song", "tts/mixed", "tts/missing"),
      [ENDPOINTS("tts/song")]: endpoints([{ prompt: "0.04" }]),
      [UNITS("tts/song")]: text(units("- Provider: $0.04/song")),
      [ENDPOINTS("tts/mixed")]: endpoints([{ prompt: "0.00002" }]),
      [UNITS("tts/mixed")]: text(units("- Provider: $20/M characters, $9/M tokens output")),
      [ENDPOINTS("tts/missing")]: json({ data: { endpoints: [] } }),
      [UNITS("tts/missing")]: text(units("- Provider: $1/M characters")),
    });

    expect(result.ok && result.rows).toEqual([]);
    expect(result.ok && result.summary.failed).toEqual(["tts/song", "tts/mixed", "tts/missing"]);
  });

  test("endpoint の 0 は無料として残す", async () => {
    const result = await run({
      [LIST]: list("tts/free"),
      [ENDPOINTS("tts/free")]: endpoints([{ prompt: "0" }]),
      [UNITS("tts/free")]: text(units("- Provider: $4/M characters")),
    });

    expect(result.ok && result.rows).toEqual([
      { modelId: "tts/free", billable: "input_text", unit: "character", variant: "", costUsd: 0 },
    ]);
  });

  test("一覧の取得失敗・契約外は ok: false にする", async () => {
    expect(await run({})).toEqual({ ok: false, reason: "list_failed" });
    expect(await run({ [LIST]: json({ data: {} }) })).toEqual({ ok: false, reason: "list_shape" });
  });

  test("一覧の重複 id を 1 回だけ引く", async () => {
    const result = await run({
      [LIST]: json({ data: [{ id: "tts/a" }, { id: "tts/a" }] }),
      [ENDPOINTS("tts/a")]: endpoints([{ prompt: "0.00002" }]),
      [UNITS("tts/a")]: text(units("- Provider: $20/M characters")),
    });

    expect(result.ok && result.summary.models).toBe(1);
  });
});
