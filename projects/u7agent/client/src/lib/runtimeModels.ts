import type {
  ModelDiagnosticStatus,
  ModelReferenceDiagnostic,
  RuntimeDiagnosticSummary,
  RuntimeModelsResponse,
  RuntimeProviderSummary,
} from "../types";

const MODEL_STATUS_LABELS: Record<ModelDiagnosticStatus, string> = {
  unknown_provider: "未知のプロバイダー",
  catalog_missing: "カタログにありません",
  unauthenticated: "未認証",
  not_in_whitelist: "whitelist 対象外",
  available: "利用可能",
  not_available: "利用可能リストにありません",
};

export type RuntimeModelDisplayRow = ModelReferenceDiagnostic & {
  key: string;
  label: string;
  statusLabel: string;
};

function modelDisplayRow(diagnostic: ModelReferenceDiagnostic, key: string): RuntimeModelDisplayRow {
  return {
    ...diagnostic,
    key,
    label: `${diagnostic.provider}/${diagnostic.id}`,
    statusLabel: MODEL_STATUS_LABELS[diagnostic.status],
  };
}

/** health の明示設定診断を、PI_MODEL 1 行と順序・重複を保つ PI_MODELS 行に分ける。 */
export function runtimeDiagnosticRows(summary: {
  piModel?: ModelReferenceDiagnostic;
  piModels?: ModelReferenceDiagnostic[];
}): { piModel: RuntimeModelDisplayRow | undefined; piModels: RuntimeModelDisplayRow[] } {
  return {
    piModel: summary.piModel ? modelDisplayRow(summary.piModel, "pi-model") : undefined,
    piModels: (summary.piModels ?? []).map((diagnostic, index) => modelDisplayRow(diagnostic, `pi-models-${index}`)),
  };
}

export type RuntimeProviderDisplayRow = {
  provider: string;
  configured: boolean;
  authSource: string;
  environmentVariables: string[];
  catalogCount: number;
  whitelistCount: number;
  availableCount: number;
  models: RuntimeModelsResponse["providers"][number]["models"];
};

const AUTH_SOURCE_LABELS: Record<string, string> = {
  environment: "環境変数",
  stored: "保存済み認証情報",
  runtime: "実行時認証情報",
  fallback: "フォールバック",
  models_json_key: "models.json のキー",
  models_json_command: "models.json のコマンド",
  unknown: "不明",
};

function providerDisplayRow(provider: RuntimeModelsResponse["providers"][number]): RuntimeProviderDisplayRow {
  return {
    provider: provider.provider,
    configured: provider.auth.configured,
    authSource: provider.auth.source ? AUTH_SOURCE_LABELS[provider.auth.source] : "要確認",
    environmentVariables: provider.auth.environmentVariables,
    catalogCount: provider.models.length,
    whitelistCount: provider.models.filter((model) => model.inWhitelist).length,
    availableCount: provider.models.filter((model) => model.available).length,
    models: provider.models,
  };
}

/** health には載せない全モデル応答をプロバイダー行へ集約し、未認証も含めて入力順で返す。 */
export function runtimeProviderRows(response: RuntimeModelsResponse): RuntimeProviderDisplayRow[] {
  return response.providers.map(providerDisplayRow);
}

export function runtimeProviderSummaryRows(providers: RuntimeProviderSummary[]): RuntimeProviderDisplayRow[] {
  return providers.map((provider) => ({
    provider: provider.provider,
    configured: provider.auth.configured,
    authSource: provider.auth.source ? AUTH_SOURCE_LABELS[provider.auth.source] : "要確認",
    environmentVariables: provider.auth.environmentVariables,
    catalogCount: provider.catalogCount,
    whitelistCount: provider.whitelistCount,
    availableCount: provider.availableCount,
    models: [],
  }));
}

/** ゲージの塗り比率。分母が 0 のときに NaN を作らない (数値は呼び出し側が別に出している) */
export function runtimeMetricRatio(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, value / total));
}

export type RuntimeDiagnosticCounts = { catalog: number; whitelist: number; available: number };

/**
 * health の集計からゲージ用の 3 数値を取り出す。1 つでも欠けたら undefined を返し、
 * 欠けた数値を 0 として棒を描かない (サーバーは 3 つを同時に返す)。
 */
export function runtimeDiagnosticCounts(summary: RuntimeDiagnosticSummary): RuntimeDiagnosticCounts | undefined {
  const { catalogCount, whitelistCount, availableCount } = summary;
  if (catalogCount === undefined || whitelistCount === undefined || availableCount === undefined) return undefined;
  return { catalog: catalogCount, whitelist: whitelistCount, available: availableCount };
}
