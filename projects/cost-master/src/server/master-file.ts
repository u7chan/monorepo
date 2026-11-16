import { readFileSync } from "node:fs";
import type { MasterState } from "./app";
import { buildPayload, parseJudgmentFile, parsePriceFile, type DroppedRow, type PriceMasterFile } from "./master";

export type LoadResult = {
  state: MasterState;
  dropped: DroppedRow[];
  reason: string | null;
};

/**
 * マスタはデプロイでしか変わらないので起動時に 1 回だけ読む。壊れていたら 503 にして、
 * 空の一覧を返さない（u7agent に「価格が消えた」と誤解させない）。
 */
export function loadMaster(pricesPath: URL, judgmentsPath: URL): LoadResult {
  const prices = readJson(pricesPath);

  if (prices === undefined) {
    return { state: { ok: false }, dropped: [], reason: "prices_missing" };
  }

  const parsedPrices = parsePriceFile(prices);

  if (!parsedPrices.ok) {
    return { state: { ok: false }, dropped: [], reason: `prices_invalid:${parsedPrices.reason}` };
  }

  const judgments = parseJudgmentFile(readJson(judgmentsPath));

  return {
    state: {
      ok: true,
      payload: buildPayload({
        version: parsedPrices.version,
        fetchedAt: parsedPrices.fetchedAt,
        rows: parsedPrices.rows,
        judgments: judgments.rows,
      }),
    },
    dropped: [...parsedPrices.dropped, ...judgments.dropped],
    reason: null,
  };
}

export function readMasterFile(path: URL): PriceMasterFile | null {
  const value = readJson(path);

  if (value === undefined) {
    return null;
  }

  const parsed = parsePriceFile(value);

  return parsed.ok ? { version: parsed.version, fetchedAt: parsed.fetchedAt, models: parsed.rows } : null;
}

function readJson(path: URL): unknown | undefined {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
