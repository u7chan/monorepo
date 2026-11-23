/**
 * 音声（TTS）モデルの価格取り込み。金額は `/endpoints` の数値、単位は
 * モデルページの `llms.txt`（`## Pricing`）から読む。公開 API は単位を返さないため、
 * 単位語をフィールドへ写して組み立てる（正は docs/adr/pricing-sources.md）。
 */
import type { CostSide, CostUnit } from "../shared/contract";
import { readJson, readText } from "./fetch-json";
import type { PriceRow } from "./master";

/** 音声モデルの一覧。画像の `/images/models` とは別の経路 */
export const SPEECH_MODELS_PATH = "/api/v1/models?output_modalities=speech";

/** 1 モデルの endpoint 一覧と、単位が載る markdown alternate */
export function speechEndpointsPath(modelId: string): string {
  return `/api/v1/models/${modelId}/endpoints`;
}

export function speechUnitDocPath(modelId: string): string {
  return `/${modelId}/llms.txt`;
}

/** モデルごとに 2 リクエスト引くので、逐次ではなく小さな並列で取る */
export const SPEECH_MAX_CONCURRENCY = 6;

export type SpeechPriceSummary = {
  models: number;
  priced: number;
  unpriced: string[];
  failed: string[];
  rows: number;
};

export type SpeechGenerateResult =
  | { ok: true; rows: PriceRow[]; summary: SpeechPriceSummary }
  | { ok: false; reason: "list_failed" | "list_shape" };

export type SpeechGenerateInput = {
  fetchImpl: typeof fetch;
  origin: string;
  previous: readonly PriceRow[];
  maxConcurrency?: number;
};

type UnitSpec = {
  unit: CostUnit;
  side: CostSide;
  billable: "input_text" | "output_audio";
  field: "prompt" | "completion";
  /** 分建ては endpoint が秒なので 60 を掛ける */
  factor: number;
};

/** `llms.txt` の単位語 → 契約の語彙。ここに無い単位は推測せず、そのモデルを失敗にする */
const UNIT_SPECS: Record<string, UnitSpec> = {
  characters: { unit: "character", side: "input", billable: "input_text", field: "prompt", factor: 1 },
  "UTF-8 bytes": { unit: "byte", side: "input", billable: "input_text", field: "prompt", factor: 1 },
  "tokens input": { unit: "token", side: "input", billable: "input_text", field: "prompt", factor: 1 },
  "tokens output": { unit: "token", side: "output", billable: "output_audio", field: "completion", factor: 1 },
  minute: { unit: "minute", side: "output", billable: "output_audio", field: "completion", factor: 60 },
};

type UnitLine = { spec: UnitSpec; amount: number };

export type PricingParse =
  | { kind: "ok"; lines: UnitLine[] }
  /** 「公開 endpoint なし」の宣言。前回行を残さない */
  | { kind: "none" }
  /** 取得はできたが契約外。前回行を残す */
  | { kind: "invalid" };

/**
 * `## Pricing` の行から単位と金額を読む。金額は `minute` の検算にだけ使い、
 * 通常の単価は endpoint の数値を正とする。
 */
export function parsePricingUnits(text: string): PricingParse {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Pricing");

  if (start === -1) {
    return { kind: "invalid" };
  }

  const block: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    block.push(line);
  }

  const parsed: UnitLine[] = [];

  for (const line of block) {
    const body = line.trim();

    if (!body.startsWith("- ")) continue;

    const colon = body.indexOf(":");

    if (colon <= 2) {
      return { kind: "invalid" };
    }

    for (const part of body.slice(colon + 1).split(",")) {
      const amount = amountOf(part.trim());

      if (amount === undefined) {
        return { kind: "invalid" };
      }

      const spec = UNIT_SPECS[amount.unit];

      if (spec === undefined) {
        return { kind: "invalid" };
      }

      parsed.push({ spec, amount: amount.value });
    }
  }

  if (parsed.length === 0) {
    return block.join("\n").includes("no public standard endpoint") ? { kind: "none" } : { kind: "invalid" };
  }

  return { kind: "ok", lines: parsed };
}

/** `$0.62/M characters` / `$0.15/minute` / `$0.50/M tokens input` の 1 項目 */
function amountOf(part: string): { value: number; unit: string } | undefined {
  const match = /^\$(\d+(?:\.\d+)?)(?:\/(?:(M|K)\s+)?([A-Za-z0-9 -]+))?$/.exec(part);

  if (match === null) {
    return undefined;
  }

  const value = Number(match[1]);

  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  const scale = match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;

  return { value: value / scale, unit: match[3] ?? "" };
}

type EndpointPricing = { prompt: number | null; completion: number | null };

function endpointPricingOf(body: unknown): EndpointPricing[] | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const data = (body as { data?: unknown }).data;

  if (typeof data !== "object" || data === null) {
    return undefined;
  }

  const endpoints = (data as { endpoints?: unknown }).endpoints;

  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return undefined;
  }

  const rows: EndpointPricing[] = [];

  for (const endpoint of endpoints) {
    // pricing を持たない endpoint はその行だけ捨てる（1 provider の欠落でモデル全体を落とさない）
    if (typeof endpoint !== "object" || endpoint === null) continue;

    const pricing = (endpoint as { pricing?: unknown }).pricing;

    if (typeof pricing !== "object" || pricing === null) continue;

    rows.push({
      prompt: priceOf((pricing as { prompt?: unknown }).prompt),
      completion: priceOf((pricing as { completion?: unknown }).completion),
    });
  }

  return rows.length === 0 ? undefined : rows;
}

/** 文字列でも数値でも受ける。負・非数値・欠落は null（0 に丸めない） */
function priceOf(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;

  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    return null;
  }

  return number;
}

function maxOf(rows: readonly EndpointPricing[], field: "prompt" | "completion"): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is number => value !== null);

  return values.length === 0 ? null : Math.max(...values);
}

/**
 * 単位の組み合わせから行を組み立てる。`unit` が 2 種類以上（文字とバイトなど）になったら
 * 混在として失敗にする（Gemini の token 入力/出力だけが 2 つの `(unit, side)` を持つ）。
 */
function rowsOfModel(
  modelId: string,
  pricing: readonly EndpointPricing[],
  lines: readonly UnitLine[],
): PriceRow[] | null {
  const specs = new Map<string, UnitSpec>();

  for (const line of lines) {
    specs.set(`${line.spec.unit}:${line.spec.side}`, line.spec);
  }

  const units = new Set([...specs.values()].map((spec) => spec.unit));

  if (units.size > 1) {
    return null;
  }

  const rows: PriceRow[] = [];

  for (const spec of specs.values()) {
    const field = maxOf(pricing, spec.field);

    if (field === null) {
      return null;
    }

    const costUsd = field * spec.factor;

    if (spec.unit === "minute") {
      const declared = Math.max(...lines.filter((line) => line.spec.unit === "minute").map((line) => line.amount));

      if (!closeEnough(costUsd, declared)) {
        return null;
      }
    }

    rows.push({ modelId, kind: "speech", billable: spec.billable, unit: spec.unit, variant: "", costUsd });
  }

  return rows;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-6);
}

type Outcome = { kind: "rows"; rows: PriceRow[] } | { kind: "none" } | { kind: "failed"; rows: PriceRow[] };

function previousRowsOf(previous: readonly PriceRow[], modelId: string): PriceRow[] {
  return previous.filter(
    (row) => row.modelId === modelId && (row.billable === "input_text" || row.billable === "output_audio"),
  );
}

async function outcomeOf(
  fetchImpl: typeof fetch,
  origin: string,
  modelId: string,
  previous: readonly PriceRow[],
): Promise<Outcome> {
  const failed: Outcome = { kind: "failed", rows: previousRowsOf(previous, modelId) };

  let endpointsBody: unknown;
  let unitDoc: string | undefined;

  try {
    [endpointsBody, unitDoc] = await Promise.all([
      readJson(fetchImpl, new URL(speechEndpointsPath(modelId), origin)),
      readText(fetchImpl, new URL(speechUnitDocPath(modelId), origin)),
    ]);
  } catch {
    return failed;
  }

  if (unitDoc === undefined) {
    return failed;
  }

  const parsed = parsePricingUnits(unitDoc);

  if (parsed.kind === "invalid") {
    return failed;
  }

  // 「公開 endpoint なし」の確定は endpoints の取得成否より先に見る（価格なしを前回行で上書きしない）
  if (parsed.kind === "none") {
    return { kind: "none" };
  }

  if (endpointsBody === undefined) {
    return failed;
  }

  const pricing = endpointPricingOf(endpointsBody);

  if (pricing === undefined) {
    return failed;
  }

  const rows = rowsOfModel(modelId, pricing, parsed.lines);

  return rows === null ? failed : { kind: "rows", rows };
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;

      if (index >= items.length) return;

      results[index] = await fn(items[index] as T);
    }
  });

  await Promise.all(workers);

  return results;
}

/** 音声の一覧 → 各モデルの endpoint と llms.txt。失敗したモデルは前回の行を残す */
export async function generateSpeechPrices(input: SpeechGenerateInput): Promise<SpeechGenerateResult> {
  const list = await readJson(input.fetchImpl, new URL(SPEECH_MODELS_PATH, input.origin));

  if (list === undefined) {
    return { ok: false, reason: "list_failed" };
  }

  const data = (list as { data?: unknown }).data;

  if (!Array.isArray(data)) {
    return { ok: false, reason: "list_shape" };
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;

    const id = (item as { id?: unknown }).id;

    if (typeof id !== "string" || id === "" || seen.has(id)) continue;

    seen.add(id);
    ids.push(id);
  }

  const outcomes = await mapWithLimit(ids, input.maxConcurrency ?? SPEECH_MAX_CONCURRENCY, (id) =>
    outcomeOf(input.fetchImpl, input.origin, id, input.previous),
  );

  const rows: PriceRow[] = [];
  const unpriced: string[] = [];
  const failed: string[] = [];
  let priced = 0;

  for (const [index, outcome] of outcomes.entries()) {
    const id = ids[index] as string;

    if (outcome.kind === "failed") {
      failed.push(id);
      rows.push(...outcome.rows);
      continue;
    }

    if (outcome.kind === "none") {
      unpriced.push(id);
      continue;
    }

    if (outcome.rows.length === 0) {
      unpriced.push(id);
      continue;
    }

    priced += 1;
    rows.push(...outcome.rows);
  }

  return {
    ok: true,
    rows,
    summary: { models: ids.length, priced, unpriced, failed, rows: rows.length },
  };
}
