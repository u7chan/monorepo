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

/** 会話選択の同一性。id だけでなく切替の世代を持つ */
export interface ServeSelection {
  sessionId: string;
  /** 会話を切り替えるたびに進む世代 */
  generation: number;
}

/**
 * 操作（起動 / 停止）の応答を適用してよいかの判定。**発行時と同じ会話選択**であること。
 *
 * 会話 id だけの照合では A → B → A と戻ったときに、切替前に発行した応答が再び有効になり、
 * 新しい状態（他会話が公開中）を古い「稼働中」で上書きし得る。切替の世代まで見て破棄する。
 */
export function canApplyServeAction(issued: ServeSelection, current: ServeSelection): boolean {
  return issued.sessionId === current.sessionId && issued.generation === current.generation;
}
