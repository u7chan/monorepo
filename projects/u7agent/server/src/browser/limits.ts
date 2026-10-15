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

/** 既定の viewport。デスクトップ幅を既定にし、スマホ幅の確認は `--width` / `--height` で行う */
export const VIEWPORT = { width: 1280, height: 720 } as const;

/** viewport の 1 辺の上限。巨大な viewport で画像を作らせない */
export const MAX_VIEWPORT_DIMENSION = 8192;

/** 1 回の呼び出しが cwd へ書ける成果物の数 */
export const MAX_OUTPUTS = 1;

/** 1 枚の画像の上限。超えたら保存せず失敗させる (成果物でディスクを埋めない) */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** 遷移の待ち時間。標準経路はループバックなので、超えるのはアプリ側の停止とみなす */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** `--wait-for-selector` の既定の待ち時間。SPA の初回描画を待つ */
export const READY_TIMEOUT_MS = 30_000;

/** 描画の完了後に check が追加で購読する時間。遅れて出る例外を拾う */
export const CHECK_SETTLE_MS = 2_000;

/** check が保持する項目の上限。同じ内容の繰り返しは 1 項目へまとめてから数える */
export const MAX_CHECK_ITEMS = 50;

/** check の 1 項目の文字数。長いスタック 1 つで出力を埋めない */
export const MAX_CHECK_TEXT_CHARS = 300;

/** check の出力全体の上限。項目の上限と二重に守る (会話のコンテキストを食わない) */
export const MAX_CHECK_OUTPUT_BYTES = 64 * 1024;

/**
 * check の要約に埋め込む URL の上限。本文の詳細と省略通知の予算を残すため、出力上限の 1/4 までにする
 * (URL は対象を指すための情報で、長い query をそのまま読ませる意味は無い)。
 */
export const MAX_CHECK_SUMMARY_URL_BYTES = MAX_CHECK_OUTPUT_BYTES / 4;

/** dom の出力上限。巨大な HTML をそのまま返さない */
export const MAX_DOM_BYTES = 256 * 1024;

/** 正の整数の引数を検証する。0 以下・非整数・桁あふれは受け付けない */
export function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}は正の整数で指定してください: ${value}`);
  return parsed;
}

/** `--deadline-ms` の値を検証する */
export function parseDeadlineMs(value: string): number {
  return parsePositiveInt(value, "期限 (ms) ");
}
