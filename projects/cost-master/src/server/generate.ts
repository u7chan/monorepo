import { readJson } from "./fetch-json";
import { generateSpeechPrices, type SpeechPriceSummary } from "./generate-speech";
import { isCostUnit, isOutputBillable, priceKey, type PriceMasterFile, type PriceRow } from "./master";

/** 上流は無料の一覧 API だけを叩く。課金を伴う実測はしない */
export const UPSTREAM_ORIGIN = "https://openrouter.ai";
export const IMAGE_MODELS_PATH = "/api/v1/images/models";

export type PriceDiff = {
  added: PriceRow[];
  removed: PriceRow[];
  changed: { before: PriceRow; after: PriceRow }[];
};

export type GenerateSummary = {
  models: number;
  priced: number;
  noPrice: number;
  failed: string[];
  rows: number;
  speech: SpeechPriceSummary;
  changed: boolean;
  diff: PriceDiff;
};

export type GenerateResult =
  | { ok: true; file: PriceMasterFile; summary: GenerateSummary }
  | { ok: false; reason: "list_failed" | "list_shape" | "speech_list_failed" | "speech_list_shape" };

export type GenerateInput = {
  fetchImpl: typeof fetch;
  previous: PriceMasterFile | null;
  now: () => number;
  origin?: string;
  /** 音声の取得も含める（既定 true）。画像だけを見るテストは false にする */
  speech?: boolean;
};

/**
 * 上流の一覧 → 各モデルの endpoints を引き、価格行を組み立てる。
 * 失敗したモデルは前回の行を残し、`endpoints: []` は「価格なし」を確定する（前回行を残さない）。
 */
export async function generatePrices(input: GenerateInput): Promise<GenerateResult> {
  const origin = input.origin ?? UPSTREAM_ORIGIN;
  const list = await readJson(input.fetchImpl, new URL(IMAGE_MODELS_PATH, origin));

  if (list === undefined) {
    return { ok: false, reason: "list_failed" };
  }

  const data = (list as { data?: unknown }).data;

  if (!Array.isArray(data)) {
    return { ok: false, reason: "list_shape" };
  }

  const models = data.map((item) => modelOf(item, origin)).filter((model): model is ModelRef => model !== null);
  const previousByModel = groupByModel(input.previous?.models ?? []);
  const rows: PriceRow[] = [];
  const failed: string[] = [];

  for (const model of models) {
    const fetched = await rowsOfModel(input.fetchImpl, model.endpoints, origin, model.modelId);

    if (fetched === null) {
      failed.push(model.modelId);
      rows.push(...(previousByModel.get(model.modelId) ?? []));
      continue;
    }

    rows.push(...fetched);
  }

  const previousRows = input.previous?.models ?? [];
  let speech: SpeechPriceSummary = { models: 0, priced: 0, unpriced: [], failed: [], rows: 0 };

  if (input.speech !== false) {
    const speechResult = await generateSpeechPrices({
      fetchImpl: input.fetchImpl,
      origin,
      previous: previousRows,
    });

    if (!speechResult.ok) {
      return { ok: false, reason: speechResult.reason === "list_failed" ? "speech_list_failed" : "speech_list_shape" };
    }

    speech = speechResult.summary;
    rows.push(...speechResult.rows);
  }

  const diff = diffRows(previousRows, rows);
  const changed = diff.added.length + diff.removed.length + diff.changed.length > 0;
  const version = (input.previous?.version ?? 0) + (changed || input.previous === null ? 1 : 0);

  const pricedModels = new Set(rows.map((row) => row.modelId));
  const failedModels = new Set([...failed, ...speech.failed]);

  return {
    ok: true,
    file: { version, fetchedAt: input.now(), models: sortRows(rows) },
    summary: {
      models: models.length + speech.models,
      priced: pricedModels.size,
      noPrice:
        models.filter((model) => !pricedModels.has(model.modelId) && !failedModels.has(model.modelId)).length +
        speech.unpriced.length,
      failed: [...failed, ...speech.failed],
      rows: rows.length,
      speech,
      changed,
      diff,
    },
  };
}

type ModelRef = { modelId: string; endpoints: string };

function modelOf(item: unknown, origin: string): ModelRef | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }

  const { id, endpoints } = item as { id?: unknown; endpoints?: unknown };

  if (typeof id !== "string" || id === "") {
    return null;
  }

  // 一覧が endpoint のパスを宣言する。宣言が無い上流の変化に備えて慣例パスへ落とす
  const path =
    typeof endpoints === "string" && endpoints !== ""
      ? endpoints
      : new URL(`${IMAGE_MODELS_PATH}/${id}/endpoints`, origin).pathname;

  return { modelId: id, endpoints: path };
}

/** モデル 1 件の価格行。取得・形の失敗は null（呼び出し側が前回行を残す） */
async function rowsOfModel(
  fetchImpl: typeof fetch,
  path: string,
  origin: string,
  modelId: string,
): Promise<PriceRow[] | null> {
  let url: URL;

  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }

  const body = await readJson(fetchImpl, url);

  if (body === undefined || typeof body !== "object" || body === null) {
    return null;
  }

  const endpoints = (body as { endpoints?: unknown }).endpoints;

  if (!Array.isArray(endpoints)) {
    return null;
  }

  const byKey = new Map<string, PriceRow>();

  for (const endpoint of endpoints) {
    if (typeof endpoint !== "object" || endpoint === null) {
      return null;
    }

    const pricing = (endpoint as { pricing?: unknown }).pricing;

    // 契約外（項目名の変更など）を「価格なしを確定」と同じ経路へ流すと、前回の行が黙って消える
    if (!Array.isArray(pricing)) {
      return null;
    }

    for (const raw of pricing) {
      const row = priceRowOf(raw, modelId);

      if (row === null) {
        continue;
      }

      const key = priceKey(row);
      const current = byKey.get(key);

      // 同じ請求単位が複数 endpoint にあるときは最大単価。配列順に依存させない
      if (current === undefined || row.costUsd > current.costUsd) {
        byKey.set(key, row);
      }
    }
  }

  return [...byKey.values()];
}

function priceRowOf(raw: unknown, modelId: string): PriceRow | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const {
    billable,
    unit,
    variant,
    cost_usd: costUsd,
  } = raw as {
    billable?: unknown;
    unit?: unknown;
    variant?: unknown;
    cost_usd?: unknown;
  };

  if (!isOutputBillable(billable) || !isCostUnit(unit)) {
    return null;
  }

  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    return null;
  }

  return {
    modelId,
    billable,
    unit,
    variant: typeof variant === "string" ? variant : "",
    costUsd,
  };
}

function groupByModel(rows: readonly PriceRow[]): Map<string, PriceRow[]> {
  const grouped = new Map<string, PriceRow[]>();

  for (const row of rows) {
    const list = grouped.get(row.modelId);

    if (list) {
      list.push(row);
    } else {
      grouped.set(row.modelId, [row]);
    }
  }

  return grouped;
}

function diffRows(previous: readonly PriceRow[], next: readonly PriceRow[]): PriceDiff {
  const before = new Map(previous.map((row) => [priceKey(row), row]));
  const after = new Map(next.map((row) => [priceKey(row), row]));
  const added: PriceRow[] = [];
  const removed: PriceRow[] = [];
  const changed: { before: PriceRow; after: PriceRow }[] = [];

  for (const [key, row] of after) {
    const old = before.get(key);

    if (old === undefined) {
      added.push(row);
    } else if (old.costUsd !== row.costUsd) {
      changed.push({ before: old, after: row });
    }
  }

  for (const [key, row] of before) {
    if (!after.has(key)) {
      removed.push(row);
    }
  }

  return { added, removed, changed };
}

/** ファイルの差分を読めるように、キーの順で固定する */
function sortRows(rows: readonly PriceRow[]): PriceRow[] {
  return [...rows].sort((a, b) => {
    const keys: readonly (keyof PriceRow)[] = ["modelId", "unit", "variant", "billable"];

    for (const key of keys) {
      if (a[key] !== b[key]) {
        return a[key] < b[key] ? -1 : 1;
      }
    }

    return 0;
  });
}
