import { COST_UNITS, type CostMasterPayload, type CostModelPrice } from "../shared/contract";

export type ModelGroup = {
  modelId: string;
  enabled: boolean;
  note: string | null;
  prices: CostModelPrice[];
};

/** 表示の単位をモデルに揃える。応答は請求単位ごとの行なので、同じモデルの行をまとめる */
export function groupByModel(models: readonly CostModelPrice[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();

  for (const model of models) {
    const group = groups.get(model.modelId);

    if (group) {
      group.prices.push(model);
      continue;
    }

    groups.set(model.modelId, {
      modelId: model.modelId,
      enabled: model.enabled,
      note: model.note,
      prices: [model],
    });
  }

  for (const group of groups.values()) {
    group.prices.sort(comparePrices);
  }

  return [...groups.values()];
}

/** 単価は unit → variant（解像度の小さい順）→ billable で読む。文字列順だと 1.5k が 1k より前に来る */
function comparePrices(a: CostModelPrice, b: CostModelPrice): number {
  if (a.unit !== b.unit) {
    return a.unit < b.unit ? -1 : 1;
  }

  const variant = compareVariant(a.variant, b.variant);

  if (variant !== 0) {
    return variant;
  }

  return a.billable < b.billable ? -1 : a.billable > b.billable ? 1 : 0;
}

function compareVariant(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  // 基本単価（variant なし）を先頭にする
  if (a === "") {
    return -1;
  }

  if (b === "") {
    return 1;
  }

  const left = variantOrder(a);
  const right = variantOrder(b);

  if (left.numeric !== right.numeric) {
    return left.numeric ? -1 : 1;
  }

  if (left.value !== right.value) {
    return left.value - right.value;
  }

  return a < b ? -1 : 1;
}

function variantOrder(variant: string): { numeric: boolean; value: number } {
  const match = /^(\d+(?:\.\d+)?)/.exec(variant);
  const prefix = match?.[1];

  return prefix === undefined ? { numeric: false, value: 0 } : { numeric: true, value: Number(prefix) };
}

export type ModelSort = "name" | "cost";

/** 一覧の並び順。名前順は応答の順（`modelId` 昇順）、単価順は同じ unit の中で先頭の価格行の安い順 */
export function sortGroups(groups: readonly ModelGroup[], sort: ModelSort): ModelGroup[] {
  const next = [...groups];

  next.sort(sort === "cost" ? compareByCost : compareByName);

  return next;
}

function compareByName(a: ModelGroup, b: ModelGroup): number {
  return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
}

function compareByCost(a: ModelGroup, b: ModelGroup): number {
  const left = a.prices[0];
  const right = b.prices[0];

  if (left === undefined || right === undefined) {
    return compareByName(a, b);
  }

  // 単位の違う単価（$0.04/枚 と $0.00003/token）は比べられないので、まず unit で分ける
  const unit = COST_UNITS.indexOf(left.unit) - COST_UNITS.indexOf(right.unit);

  if (unit !== 0) {
    return unit;
  }

  if (left.costUsd !== right.costUsd) {
    return left.costUsd - right.costUsd;
  }

  return comparePrices(left, right) || compareByName(a, b);
}

export type MasterSummary = { models: number; rows: number; hidden: number };

export function summarize(models: readonly CostModelPrice[]): MasterSummary {
  const groups = groupByModel(models);

  return {
    models: groups.length,
    rows: models.length,
    hidden: groups.filter((group) => !group.enabled).length,
  };
}

/** 画面で確定した判断を 1 モデル分だけ反映する。同じモデルに価格行が複数あるので全行を揃える */
export function withModelEnabled(payload: CostMasterPayload, modelId: string, enabled: boolean): CostMasterPayload {
  return {
    ...payload,
    models: payload.models.map((model) => (model.modelId === modelId ? { ...model, enabled } : model)),
  };
}
