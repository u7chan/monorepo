import { readFileSync } from "node:fs";
import type { MasterState } from "./app";
import { buildPayload, parseJudgmentFile, parsePriceFile, type DroppedRow } from "./master";

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
    return { state: { ok: false }, dropped: [], reason: "prices_read_failed" };
  }

  const parsedPrices = parsePriceFile(prices);

  if (!parsedPrices.ok) {
    return { state: { ok: false }, dropped: [], reason: `prices_invalid:${parsedPrices.reason}` };
  }

  const rawJudgments = readJson(judgmentsPath);

  if (rawJudgments === undefined) {
    return { state: { ok: false }, dropped: [], reason: "judgments_read_failed" };
  }

  const judgments = parseJudgmentFile(rawJudgments);

  if (!judgments.ok) {
    return { state: { ok: false }, dropped: [], reason: `judgments_invalid:${judgments.reason}` };
  }

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

/** JSON として読めない（無い / 壊れている）をまとめて undefined にする。どちらも運用では「配布物が違う」 */
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
