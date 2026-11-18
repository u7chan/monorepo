/**
 * 取得間隔は provider ごとに選ぶ。上流のレート制限は公開されていないため、
 * 画面から選べる値はここで固定し、サーバーと画面で同じ一覧を使う。
 * 1 分は出さない。利用枠の最小単位（5 時間）に対して新しくなる情報がほとんど無く、
 * 上流を叩く回数だけが増えるため。
 */
export const FETCH_INTERVAL_OPTIONS_MINUTES = [5, 10, 30, 60, 120] as const;

export const DEFAULT_FETCH_INTERVAL_MINUTES = 10;

export const FETCH_INTERVAL_PROVIDERS = ["codex", "opencode-go"] as const;

export type FetchIntervalProvider = (typeof FETCH_INTERVAL_PROVIDERS)[number];

export function isFetchIntervalProvider(value: unknown): value is FetchIntervalProvider {
  return typeof value === "string" && (FETCH_INTERVAL_PROVIDERS as readonly string[]).includes(value);
}

export function isFetchIntervalMinutes(value: unknown): value is number {
  return typeof value === "number" && (FETCH_INTERVAL_OPTIONS_MINUTES as readonly number[]).includes(value);
}

/** 分で持っている設定を、sampler と API が使うミリ秒へ直す。 */
export function fetchIntervalMs(minutes: number): number {
  return minutes * 60_000;
}
