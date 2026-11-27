/**
 * 状態取得の応答を適用してよいかの判定。「最新の要求だけ」にすると応答がポーリング間隔より遅いときに
 * 永久に更新されないため、適用は番号の新しさだけで決め、操作が無効化した番号以前は捨てる。
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
 * 操作 (起動 / 停止) の応答を適用してよいかの判定。発行時と同じ会話選択であることまで見る (id だけ
 * だと A → B → A で切替前の応答が再び有効になり、新しい状態を古い「稼働中」で上書きする)。
 */
export function canApplyServeAction(issued: ServeSelection, current: ServeSelection): boolean {
  return issued.sessionId === current.sessionId && issued.generation === current.generation;
}
