/**
 * 待機キュー (202 で受理し、まだ実行されていない送信) の表示。順位の権威はサーバーで、クライアントは
 * 受け取った順位を保持する。表示の直前に保持している待機集合を並べ直して 1..N を振り直すため、
 * 先頭が抜けたら残りが繰り上がる。件数はここで数えた配列の長さで、サーバーの `queueDepth` は使わない。
 */
import type { Bubble } from "./chatTypes";

export type QueuedSend = {
  /** 取り消しの対象と、行の同一性 (繰り上がる順位は key に使えない)。履歴 item への吸収の対応付けも兼ねる */
  sendId: string;
  /** 送信の本文 (添付の注記とスキルブロックを含む生の形。表示の整形は呼び出し側) */
  text: string;
  /**
   * `queued` は BFF 待機中か SDK の実キューに残る (取消できる)。`steering` は SDK が取り出して
   * 注入待ちで、反映中として見せる (取消・再送・破棄は不可)
   */
  state: "queued" | "steering";
  /** 並べ直した 1 始まりの順位。1 件だけ / 順位が不明 (旧サーバー) のときは無い (数字を出さない) */
  index?: number;
};

/**
 * 待機中の送信を実行順に並べる。待機していないバブルは載らない。
 * 1 件でも順位が不明なら番号を出さない: 一部だけ番号を出すと、不明な分の中で何番目かが読めない。
 */
export function queuedSendsOf(bubbles: Bubble[]): QueuedSend[] {
  const known: Array<{ send: QueuedSend; position: number }> = [];
  const unknown: QueuedSend[] = [];
  for (const bubble of bubbles) {
    // 送信IDの無い待機は取り消しの対象を指定できないため落とす (待機の表示は応答が sendId を配ってから)
    if (bubble.queued !== true || bubble.sendId === undefined) continue;
    const send: QueuedSend = { sendId: bubble.sendId, text: bubble.text, state: bubble.queuedState ?? "queued" };
    if (bubble.queuePosition === undefined) unknown.push(send);
    else known.push({ send, position: bubble.queuePosition });
  }
  known.sort((a, b) => a.position - b.position);
  // 順位が分かる分だけで並べ替え、不明な分は元の並びのまま後ろへ回す (並び順の根拠を混ぜない)
  const ordered = [...known.map((item) => item.send), ...unknown];
  const numbered = unknown.length === 0 && ordered.length > 1;
  return ordered.map((send, index) => (numbered ? { ...send, index: index + 1 } : send));
}

/**
 * 回答待ち (ask_user) の run が終わるまで動かない送信の理由。footnote の「上の質問に回答して
 * ください（N件）」だけでは回答すれば実行されると読めるため、実行の起点が run の終了であることを
 * 1 文で示す。回答が要らない待ち (実行中 / 圧縮中) は undefined を返し、状態行の活動文言に任せる。
 */
export function answerWaitQueueReason(pendingQuestions: number, queueDepth: number): string | undefined {
  if (pendingQuestions <= 0 || queueDepth <= 0) return undefined;
  return "回答後、この応答とツールが終わった時点で待機中の送信が反映されます";
}
