/**
 * 追加入力の配送状態の導出。SDK は `steeringMode: "all"` のとき実キューをまとめてドレインするため、
 * 「SDK が取り出してもう取り消せない (taken)」は保存せず、実キューの残数との差から導出する。
 */
import type { SessionRecord } from "./session-record";

/** SDK が実キューを一括でドレインする設定か (旧 SDK は `steeringMode` を持たない) */
export function batchesSteering(record: SessionRecord): boolean {
  return record.session.steeringMode === "all";
}

/**
 * SDK の実キューに未注入で残る件数。`"all"` では BFF が渡した steering のうち末尾側の未注入分。
 * 公開 API が無い実装は 0 として扱い、渡した分を「取り出し済み」に倒す (取り消せないものを
 * 取り消せるように見せない)。
 */
export function sdkQueueLength(record: SessionRecord): number {
  try {
    return record.session.agent?.peekQueuedMessages?.().length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * SDK がドレインしてもう取り消せない送信ID。実キューは BFF の受付順の末尾側に残るため、
 * `handedOff` かつ `steered` の件数から実キューの件数を引いた先頭分が taken になる。
 * 一括ドレインを持たない SDK では全件ドレインの前提が成り立たないため、空を返して呼び出し側に
 * 実キュー件数での判定を任せる。
 */
export function takenSendIdsOf(record: SessionRecord): Set<string> {
  if (!batchesSteering(record)) return new Set();
  const steered = record.queue.filter((item) => item.handedOff === true && item.steered === true);
  const taken = Math.max(0, steered.length - sdkQueueLength(record));
  return new Set(steered.slice(0, taken).map((item) => item.sendId));
}
