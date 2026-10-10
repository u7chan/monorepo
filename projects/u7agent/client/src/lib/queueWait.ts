/**
 * 待機キュー (202 で受理し、まだ実行されていない送信) の表示。順位の権威はサーバーで、クライアントは
 * 受け取った順位を保持する。表示の直前に保持している待機集合を並べ直して 1..N を振り直すため、
 * 先頭が抜けたら残りが繰り上がる。件数 (分母) はサーバーの `queueDepth` ではなく、ここで数える。
 */
import type { Bubble } from "./chatTypes";

export type QueueWait = {
  /** 並べ直した 1 始まりの順位。1 件だけ / 順位が不明 (旧サーバー) のときは無い (数字を出さない) */
  index?: number;
  /** 保持している待機集合の件数 (分母) */
  total: number;
};

/**
 * 待機中のバブル id -> 表示用の順位と件数。待機していないバブルは載らない。
 * 1 件でも順位が不明なら番号を出さない: 一部だけ番号を出すと、不明な分の中で何番目かが読めない。
 */
export function queueWaitsOf(bubbles: Bubble[]): Map<number, QueueWait> {
  const known: Array<{ bubble: Bubble; position: number }> = [];
  const unknown: Bubble[] = [];
  for (const bubble of bubbles) {
    if (bubble.queued !== true) continue;
    if (bubble.queuePosition === undefined) unknown.push(bubble);
    else known.push({ bubble, position: bubble.queuePosition });
  }
  const total = known.length + unknown.length;
  if (total === 0) return new Map();
  known.sort((a, b) => a.position - b.position);
  // 順位が分かる分だけで並べ替え、不明な分は元の並びのまま後ろへ回す (並び順の根拠を混ぜない)
  const numbered = unknown.length === 0 && total > 1;
  const waits = new Map<number, QueueWait>();
  [...known.map((item) => item.bubble), ...unknown].forEach((bubble, index) => {
    waits.set(bubble.id, numbered ? { index: index + 1, total } : { total });
  });
  return waits;
}

/**
 * 状態行の待機サマリ。順位は各バブルのチップが担うため、状態行は件数だけを出し、待機の理由
 * (`実行中…` / `圧縮中…` / `完了`) は呼び出し側が接頭辞で示す。
 */
export function queueWaitSummary(prefix: string, queueDepth: number): string {
  const count = `待機 ${queueDepth} 件`;
  return prefix === "" ? count : `${prefix} · ${count}`;
}
