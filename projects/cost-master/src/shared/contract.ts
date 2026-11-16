/** 上流の `unit` 語彙。これ以外の行はマスタに載せない（表示側が単価を整形できないため） */
export const COST_UNITS = ["image", "megapixel", "token", "request"] as const;
export type CostUnit = (typeof COST_UNITS)[number];

/** 上流が複数 provider を返しても、この版では 1 つに固定する */
export const PROVIDER = "openrouter";

export const SERVICE_NAME = "cost-master";

/** `fetchedAt` は epoch ms。u7agent の `catalogSource` / `fetchedAt` と同じ単位に揃える */
export type CostModelPrice = {
  provider: string;
  modelId: string;
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
