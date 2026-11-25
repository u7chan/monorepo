/**
 * 会話履歴のクリア (clearHistory) のうち、ファイルと保存の手順 (実行と巻き戻し) を持つ。どの失敗で
 * どこまで戻すかをこの 1 module で追えるようにし、SessionStore には予約・確定・配信の順序だけを残す。
 * 競合の予約 (lifecycle / deleting / closing) と record の所有は会話ストアに残す
 * (docs/architecture.md の「所有者は 1 つに保つ」)。ここからは port 越しにだけそれらへ触る。
 */
import type { SessionRecord } from "./session-record";
import { titleOriginOf } from "./session-title";
import { removeSessionHistory, type SessionMeta } from "./session-store";

/** 手順が使う保存先。会話ストアの状態は含めない */
export interface HistoryClearFiles {
  storeDir: string;
}

/** 手順が会話ストアへ要求する口。private を公開せずに切り出すための境界 */
export interface HistoryClearPort {
  /** 確定前: この会話の新しい書込みを止める (旧世代の要約の適用・保存を止める) */
  holdWrites(record: SessionRecord): void;
  /** 確定前の失敗: 止めた書込みを解く。確定後は呼ばない (旧世代の結果を適用しないため) */
  releaseWrites(record: SessionRecord): void;
  /** 確定前: まだ確定していない保存を流す */
  drainWrites(record: SessionRecord): Promise<void>;
  /** 待機の後に確定へ使う meta を組み直すため、今の meta を読む。削除済みなら undefined */
  currentMeta(): SessionMeta | undefined;
  /** 確定点。meta を保存し、未ロードの一覧と live な record の両方へ反映する */
  saveMeta(meta: SessionMeta): Promise<void>;
  /** 確定後: live な record を open から外し、未完了の保存を流す */
  releaseRecord(record: SessionRecord): Promise<void>;
  /** 応答の実測行。履歴の削除に成功した後だけ消す */
  deleteAssistantMetrics(id: string): void;
}

/** 確定に使う meta を組み立てる口。undefined は現世代で消すものが無い */
export type BuildClearedMeta = (current: SessionMeta) => SessionMeta | undefined;

/** `missing` は会話が消えた (応答を返さない)。`unchanged` は消すものが無い */
export type ConfirmedHistoryClear =
  | { kind: "missing" }
  | { kind: "unchanged"; meta: SessionMeta }
  | { kind: "confirmed"; meta: SessionMeta };

/**
 * 確定点まで。書込みを止めて drain し、待機中に変わった meta で組み直してから meta を書く。
 * 確定前の失敗では止めた書込みを解き、旧履歴を残す (確定後は旧世代の結果を適用しない)。
 */
export async function confirmHistoryClear(
  port: HistoryClearPort,
  input: { live: SessionRecord | undefined; buildMeta: BuildClearedMeta },
): Promise<ConfirmedHistoryClear> {
  const { live } = input;
  if (live) port.holdWrites(live);
  try {
    if (live) await port.drainWrites(live);
    const current = port.currentMeta();
    // live な record は必ず meta を持つため、ここへ来るのは対象が開始後に消えた場合だけ。
    // その record にはもう書かないので、止めた書込みは解かない
    if (!current) return { kind: "missing" };
    // drain 中の setTitle / setNotify を落とさないよう、最新の meta から組み立て直す
    const updated = input.buildMeta(current);
    if (!updated) {
      if (live) port.releaseWrites(live);
      return { kind: "unchanged", meta: current };
    }
    // ここが確定点。新しい履歴世代・片付け待ち・チップの解除を meta に同時に保存する
    await port.saveMeta(updated);
    return { kind: "confirmed", meta: updated };
  } catch (error) {
    if (live) port.releaseWrites(live);
    throw error;
  }
}

/**
 * 確定後の片付け。旧 SDK を閉じて書込みが止まってから旧履歴と実測を消し、片付けの印を落とす。
 * 戻り値は片付け待ちが残ったか。確定後は戻さず、次に開いたときの読み込み / 保存で再試行する。
 */
export async function cleanupHistoryClear(
  files: HistoryClearFiles,
  port: HistoryClearPort,
  input: { id: string; live: SessionRecord | undefined; meta: SessionMeta },
): Promise<boolean> {
  if (input.live) await port.releaseRecord(input.live);
  try {
    await removeSessionHistory(files.storeDir, input.id);
  } catch {
    return true;
  }
  port.deleteAssistantMetrics(input.id);
  const cleared: SessionMeta = { ...input.meta };
  delete cleared.historyCleanup;
  try {
    await port.saveMeta(cleared);
  } catch {
    // 確定は済んでいる。印が残るだけなので次の読み込み / 保存で再試行する
    return true;
  }
  return false;
}

/**
 * 確定点で保存する meta。タイトルは手動のものだけ残し、消した履歴の要約の材料と試行は落とす。
 * 既存の引き継ぎメモは残し、未使用の参照チップだけを解除する (送信の受理と同じ印)。
 */
export function clearedSessionMeta(
  current: SessionMeta,
  inputs: { model?: string; thinkingLevel?: string },
  historyGeneration: string,
): SessionMeta {
  const keepTitle = titleOriginOf(current) === "manual";
  const updated: SessionMeta = {
    ...current,
    messageCount: 0,
    historyGeneration,
    historyCleanup: true,
    ...(inputs.model ? { model: inputs.model } : {}),
    ...(inputs.thinkingLevel ? { thinkingLevel: inputs.thinkingLevel } : {}),
    title: keepTitle ? current.title : "",
    titleOrigin: keepTitle ? "manual" : "auto",
    ...(current.handoff ? { handoff: { ...current.handoff, consumed: true } } : {}),
  };
  delete updated.titleRequest;
  delete updated.titleAttempt;
  return updated;
}
