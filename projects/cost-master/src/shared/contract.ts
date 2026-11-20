/** 上流の `unit` 語彙。これ以外の行はマスタに載せない（表示側が単価を整形できないため） */
export const COST_UNITS = ["image", "megapixel", "token", "character", "byte", "minute", "request"] as const;
export type CostUnit = (typeof COST_UNITS)[number];

/**
 * モデルの種類。`unit` と `billable` では判別できない（`token` は画像にも音声にもあり、
 * 音声の多くは入力の行しか持たない）ので、取り込みの系統で確定させて行に持たせる。
 */
export const COST_KINDS = ["image", "speech"] as const;
export type CostKind = (typeof COST_KINDS)[number];

export function isCostKind(value: unknown): value is CostKind {
  return typeof value === "string" && (COST_KINDS as readonly string[]).includes(value);
}

/**
 * 価格行が「何を」請求するか。画像は出力だけ、TTS は入力（文字・バイト・トークン）と
 * 出力（音声トークン・分）の両方を返す。
 */
export const COST_BILLABLES = ["output_image", "input_text", "output_audio"] as const;
export type CostBillable = (typeof COST_BILLABLES)[number];

export function isCostBillable(value: unknown): value is CostBillable {
  return typeof value === "string" && (COST_BILLABLES as readonly string[]).includes(value);
}

/** 表示用の入力 / 出力。`billable` の語彙を DTO へ持ち込まないための正規化 */
export type CostSide = "input" | "output";

export function sideOfBillable(billable: string): CostSide {
  return billable.startsWith("input_") ? "input" : "output";
}

/** 上流が複数 provider を返しても、この版では 1 つに固定する */
export const PROVIDER = "openrouter";

export const SERVICE_NAME = "cost-master";

/** マスタのファイル種別。画面からのダウンロード / アップロードの対象 */
export const MASTER_KINDS = ["prices", "enabled"] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

export function isMasterKind(value: string): value is MasterKind {
  return (MASTER_KINDS as readonly string[]).includes(value);
}

/** `fetchedAt` は epoch ms。u7agent の `catalogSource` / `fetchedAt` と同じ単位に揃える */
export type CostModelPrice = {
  provider: string;
  modelId: string;
  kind: CostKind;
  billable: string;
  unit: CostUnit;
  /** 解像度ティアとは限らない（`style_references` などの加算オプションを含む）。宣言が無ければ "" */
  variant: string;
  costUsd: number;
  currency: "USD";
  /** 人手の判断。既定は true */
  enabled: boolean;
  note: string | null;
};

export type CostMasterPayload = {
  /** 価格行が変わったときだけ進む世代 */
  version: number;
  /** 価格データの取得時刻 (epoch ms) */
  fetchedAt: number;
  models: CostModelPrice[];
};

export type CostMasterHealth = {
  ok: boolean;
  service: typeof SERVICE_NAME;
  /** マスタを読めていないときは null */
  masterFetchedAt: number | null;
  version: number | null;
};

export type CostMasterError = { error: "master_unavailable" };

/** 画面のスイッチから 1 モデルの判断を変える要求 */
export type JudgmentUpdate = {
  modelId: string;
  enabled: boolean;
};

export type JudgmentApplied = { applied: true };
