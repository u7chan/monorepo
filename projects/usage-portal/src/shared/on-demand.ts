/**
 * 周期取得（sampler）に乗せず、画面を開いたときと手動更新だけで取る provider。
 * server の stale 判定・取得間隔と、client の文言が同じ判定を使う。
 */
export const ON_DEMAND_PROVIDERS = ["claude", "gemini"] as const;

export type OnDemandProvider = (typeof ON_DEMAND_PROVIDERS)[number];

/** 取得から stale と見なすまでの時間。画面を開いたときの自動取得もこの間隔を空ける。 */
export const ON_DEMAND_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function isOnDemandProvider<T extends string>(provider: T): provider is Extract<T, OnDemandProvider> {
  return (ON_DEMAND_PROVIDERS as readonly string[]).includes(provider);
}
