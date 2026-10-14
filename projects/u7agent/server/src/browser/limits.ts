/**
 * 標準経路の資源上限。既定を 1 か所にだけ置き、サブコマンドはここを上書きしない。
 */

/** 呼び出し全体の期限。標準経路はループバックの fixture が主で、外部待ちを想定しない */
export const CALL_DEADLINE_MS = 120_000;

/**
 * 同時に動かせる呼び出しの数。1 呼び出しは Chromium のプロセス群 (数百 MiB) を持つため、
 * 隔離した一時領域だけでは総資源の上限にならない (入場制御は concurrency.ts)。
 */
export const MAX_CONCURRENT_CALLS = 3;

/** Playwright の既定と同じ。サブコマンドが指定しない限りこの値を使う */
export const VIEWPORT = { width: 1280, height: 720 } as const;

/** 1 回の呼び出しが cwd へ書ける成果物の数 */
export const MAX_OUTPUTS = 1;

/** 1 枚の画像の上限。超えたら保存せず失敗させる (成果物でディスクを埋めない) */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** `--deadline-ms` の値を検証する。整数以外と 0 以下は受け付けない */
export function parseDeadlineMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`期限は正の整数 (ms) で指定してください: ${value}`);
  return parsed;
}
