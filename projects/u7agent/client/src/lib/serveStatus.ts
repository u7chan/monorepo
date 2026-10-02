/**
 * サービスの状態取得の応答を適用してよいかの判定。
 *
 * 「最新の要求だけを適用する」ゲートにすると、応答がポーリング間隔（4 秒）より遅いときに
 * どの応答も採用されず、状態が永久に更新されない（実機で発生）。適用は番号の新しさだけで決め、
 * 操作（起動 / 停止）が無効化した番号以前の応答は捨てる。
 */
export function canApplyStatus(seq: number, invalidatedUpTo: number, appliedSeq: number): boolean {
  return seq > invalidatedUpTo && seq > appliedSeq;
}
