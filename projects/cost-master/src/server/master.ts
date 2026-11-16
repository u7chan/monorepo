import { COST_UNITS, PROVIDER, type CostMasterPayload, type CostModelPrice, type CostUnit } from "../shared/contract";

/** `src/server/data/prices.json` の 1 行。請求単位（billable）ごとに持つ */
export type PriceRow = {
  modelId: string;
  billable: string;
  unit: CostUnit;
  variant: string;
  costUsd: number;
};

/** 価格は機械生成なので、世代と取得時刻も同じファイルが持つ */
export type PriceMasterFile = {
  version: number;
  fetchedAt: number;
  models: PriceRow[];
};

/** `src/server/data/enabled.json` の 1 行。人が編集する */
export type JudgmentRow = {
  modelId: string;
  enabled: boolean;
  note?: string;
};

export type JudgmentFile = {
  models: JudgmentRow[];
};

export type DropReason =
  | "shape"
  | "model-id"
  | "billable"
  | "unit"
  | "variant"
  | "cost"
  | "duplicate"
  | "enabled"
  | "note"
  | "conflict";

export type DroppedRow = { modelId: string; reason: DropReason };

export type PriceParseResult =
  | { ok: true; version: number; fetchedAt: number; rows: PriceRow[]; dropped: DroppedRow[] }
  | { ok: false; reason: "shape" | "version" | "fetchedAt" | "models" };

const BILLABLE_PREFIX = "output_";

export function isCostUnit(value: unknown): value is CostUnit {
  return typeof value === "string" && (COST_UNITS as readonly string[]).includes(value);
}

/** 出力側の単価だけを選択の指標にする。`unit` では判定しない（`input_image` + `token` が実在する） */
export function isOutputBillable(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(BILLABLE_PREFIX);
}

/**
 * 価格ファイルの検証。行の不備は落とし、トップレベルの不備は「マスタを読めない」として区別する
 * （後者は 503 にして u7agent に前回値を持たせる）。
 */
export function parsePriceFile(value: unknown): PriceParseResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "shape" };
  }

  const file = value as { version?: unknown; fetchedAt?: unknown; models?: unknown };

  if (!isCount(file.version)) {
    return { ok: false, reason: "version" };
  }

  if (!isEpochMs(file.fetchedAt)) {
    return { ok: false, reason: "fetchedAt" };
  }

  if (!Array.isArray(file.models)) {
    return { ok: false, reason: "models" };
  }

  const rows: PriceRow[] = [];
  const dropped: DroppedRow[] = [];
  const seen = new Set<string>();

  for (const item of file.models) {
    const parsed = parsePriceRow(item);

    if ("reason" in parsed) {
      dropped.push({ modelId: labelOf(item), reason: parsed.reason });
      continue;
    }

    const key = priceKey(parsed);

    if (seen.has(key)) {
      dropped.push({ modelId: parsed.modelId, reason: "duplicate" });
      continue;
    }

    seen.add(key);
    rows.push(parsed);
  }

  return { ok: true, version: file.version, fetchedAt: file.fetchedAt, rows, dropped };
}

function parsePriceRow(item: unknown): PriceRow | { reason: DropReason } {
  if (typeof item !== "object" || item === null) {
    return { reason: "shape" };
  }

  const row = item as { modelId?: unknown; billable?: unknown; unit?: unknown; variant?: unknown; costUsd?: unknown };

  if (typeof row.modelId !== "string" || row.modelId === "") {
    return { reason: "model-id" };
  }

  if (!isOutputBillable(row.billable)) {
    return { reason: "billable" };
  }

  if (!isCostUnit(row.unit)) {
    return { reason: "unit" };
  }

  if (row.variant !== undefined && typeof row.variant !== "string") {
    return { reason: "variant" };
  }

  if (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0) {
    return { reason: "cost" };
  }

  return {
    modelId: row.modelId,
    billable: row.billable,
    unit: row.unit,
    variant: row.variant ?? "",
    costUsd: row.costUsd,
  };
}

export type JudgmentParseResult =
  | { ok: true; rows: Map<string, JudgmentRow>; dropped: DroppedRow[] }
  | { ok: false; reason: "shape" | "models" };

/**
 * 人手の判断。行の破損は落として既定（表示する）へ倒すが、ファイル全体が読めないときは失敗にする。
 * 判断が 1 件も適用されないまま「全部表示」を配信すると、隠したつもりのモデルが黙って戻る。
 */
export function parseJudgmentFile(value: unknown): JudgmentParseResult {
  const rows = new Map<string, JudgmentRow>();
  const conflicted = new Set<string>();
  const dropped: DroppedRow[] = [];

  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "shape" };
  }

  const models = (value as { models?: unknown }).models;

  if (!Array.isArray(models)) {
    return { ok: false, reason: "models" };
  }

  for (const item of models) {
    if (typeof item !== "object" || item === null) {
      dropped.push({ modelId: "", reason: "shape" });
      continue;
    }

    const row = item as { modelId?: unknown; enabled?: unknown; note?: unknown };

    if (typeof row.modelId !== "string" || row.modelId === "") {
      dropped.push({ modelId: "", reason: "model-id" });
      continue;
    }

    if (typeof row.enabled !== "boolean") {
      dropped.push({ modelId: row.modelId, reason: "enabled" });
      continue;
    }

    if (row.note !== undefined && typeof row.note !== "string") {
      dropped.push({ modelId: row.modelId, reason: "note" });
      continue;
    }

    if (conflicted.has(row.modelId)) {
      continue;
    }

    const existing = rows.get(row.modelId);

    if (existing) {
      if (existing.enabled !== row.enabled) {
        rows.delete(row.modelId);
        conflicted.add(row.modelId);
        dropped.push({ modelId: row.modelId, reason: "conflict" });
      }

      continue;
    }

    rows.set(row.modelId, {
      modelId: row.modelId,
      enabled: row.enabled,
      ...(row.note === undefined || row.note === "" ? {} : { note: row.note }),
    });
  }

  return { ok: true, rows, dropped };
}

/** 価格行に人手の判断を重ね、応答の形へ写す。`enabled` の既定は true（判断が無い = 隠さない） */
export function buildPayload(input: {
  version: number;
  fetchedAt: number;
  rows: readonly PriceRow[];
  judgments: ReadonlyMap<string, JudgmentRow>;
}): CostMasterPayload {
  const models = input.rows
    .map((row) => {
      const judgment = input.judgments.get(row.modelId);

      return {
        provider: PROVIDER,
        modelId: row.modelId,
        billable: row.billable,
        unit: row.unit,
        variant: row.variant,
        costUsd: row.costUsd,
        currency: "USD" as const,
        enabled: judgment?.enabled ?? true,
        note: judgment?.note ?? null,
      } satisfies CostModelPrice;
    })
    .sort(comparePrices);

  return { version: input.version, fetchedAt: input.fetchedAt, models };
}

function comparePrices(a: CostModelPrice, b: CostModelPrice): number {
  const left = [a.modelId, a.unit, a.variant, a.billable];
  const right = [b.modelId, b.unit, b.variant, b.billable];

  for (const [index, value] of left.entries()) {
    const other = right[index] ?? "";

    if (value !== other) {
      return value < other ? -1 : 1;
    }
  }

  return 0;
}

export function priceKey(row: Pick<PriceRow, "modelId" | "billable" | "unit" | "variant">): string {
  return `${row.modelId}\u0000${row.billable}\u0000${row.unit}\u0000${row.variant}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function labelOf(item: unknown): string {
  if (typeof item !== "object" || item === null) {
    return "";
  }

  const modelId = (item as { modelId?: unknown }).modelId;

  return typeof modelId === "string" ? modelId : "";
}
