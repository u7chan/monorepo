export const CATALOG_TIMEOUT_MS = 10_000;

// 上流の応答本文はログや UI に出さない。
export const CATALOG_ERROR_TIMEOUT = "モデル一覧の取得がタイムアウトしました";
export const CATALOG_ERROR_RATE_LIMITED = "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）";
export const CATALOG_ERROR_UNKNOWN = "モデル一覧を取得できませんでした";
