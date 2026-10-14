/**
 * CLI の引数。`--self-test` だけを持つ Phase 1 の契約と、資源上限の案内をここに置く。
 * サブコマンド (Phase 2 / Phase 3) はこのファイルへ足す。
 */
import {
  CALL_DEADLINE_MS,
  MAX_CONCURRENT_CALLS,
  MAX_IMAGE_BYTES,
  MAX_OUTPUTS,
  parseDeadlineMs,
  VIEWPORT,
} from "./limits";

export interface CliOptions {
  selfTest: boolean;
  deadlineMs: number;
}

export const USAGE = `u7agent-browser — サンドボックス内のヘッドレスブラウザ

使い方:
  u7agent-browser --self-test [--deadline-ms <ms>]   同梱物と外部到達ポリシーを検証する (イメージの probe 用)
  u7agent-browser --help

資源上限:
  期限 ${CALL_DEADLINE_MS} ms / viewport ${VIEWPORT.width}x${VIEWPORT.height} / 成果物 ${MAX_OUTPUTS} 件 /
  画像 ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MiB / 同時実行 ${MAX_CONCURRENT_CALLS} 件
  (同時実行の上限に達したら実行せずに終了する。呼び出しごとに独立したプロセスと一時領域を持つ)

外部到達:
  ループバック (127.0.0.1 / localhost / [::1]) 以外へは通信しない。data: URL は対象外。

起動引数:
  --no-sandbox / --disable-gpu / --disable-dev-shm-usage / --disable-breakpad / --hide-scrollbars を常に付ける。
  HOME は呼び出しごとの一時領域へ置き、--user-data-dir は Playwright に任せる。
`;

/** 実行できない引数は undefined を返し、入口が使い方を出して終了する */
export function parseArgs(argv: readonly string[]): CliOptions | undefined {
  const rest = [...argv];
  let selfTest = false;
  let deadlineMs = CALL_DEADLINE_MS;
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--self-test") {
      selfTest = true;
      continue;
    }
    if (arg === "--deadline-ms") {
      deadlineMs = parseDeadlineMs(rest.shift() ?? "");
      continue;
    }
    throw new Error(`未対応の引数です: ${arg}`);
  }
  return selfTest ? { selfTest, deadlineMs } : undefined;
}
