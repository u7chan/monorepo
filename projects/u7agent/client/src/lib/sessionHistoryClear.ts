/**
 * 会話履歴のクリア (同じ URL のまま履歴だけを消す) の純関数。実行を止める理由・確認文言・
 * 履歴世代の判定と、旧履歴を落とした payload の組み立てを持ち、DOM に依存させない
 * (client に DOM テスト基盤が無いため、文言はここで固定する)。要求と再読み込みの順序は
 * `client/src/hooks/sessionHistory.ts` が持つ。
 */
import type { ConfirmRequest } from "./confirmDialog";
import { sessionBusy } from "./sessionBusy";
import type { SessionPayload, SessionSummary } from "../types";

/** 確定後の削除 (片付け) が残ったときの状態行の文言。開き直すと削除から再試行する */
export const HISTORY_CLEAR_CLEANUP_NOTE =
  "会話履歴をクリアしましたが、片付け（旧履歴の削除）が残っています。会話を開き直すと再試行します。";

/**
 * 履歴のクリアを止める理由。実行できるなら空文字。
 * サーバーの 409 と同じ条件 (実行中・回答待ち・キュー待ち・圧縮中・片付け中) を画面側でも示す。
 */
export function historyClearBlockedReason(
  item: Pick<SessionSummary, "status" | "queueDepth" | "awaitingAnswer" | "handoffCleanup" | "historyCleanup">,
): string {
  if (item.handoffCleanup === true) {
    return "前回の引き継ぎの片付けが残っています。会話を開いてから、もう一度お試しください。";
  }
  if (item.historyCleanup === true) {
    return "前回のクリアの片付けが残っています。会話を開いてから、もう一度お試しください。";
  }
  // 終端 (completed / stopped / error) は依頼中ではない (サーバーの isBusy と同じ集合)
  const busy = sessionBusy(item.status);
  if (busy || item.queueDepth > 0 || item.awaitingAnswer === true) {
    return "実行中・回答待ち・キュー待ち・圧縮中は履歴を消せません。完了を待ってから開き直してください。";
  }
  return "";
}

/**
 * 履歴のクリアの確認。消えるもの (メッセージ・未送信・自動タイトル) と消えないもの
 * (会話の URL・設定・作業フォルダのファイル・添付・既存のメモ) を実行前に示し、元に戻せないことを伝える。
 */
export function sessionHistoryClearConfirmRequest(title: string): ConfirmRequest {
  return {
    kind: "confirm",
    title: "会話履歴をクリア",
    ...(title ? { subject: { label: "対象の会話", value: title } } : {}),
    body: [
      "メッセージと未送信、圧縮の要約、自動で付いたタイトルを削除します。元に戻せません。",
      "会話の URL・設定・ピン留め・通知はそのままで、同じ URL から空の履歴で再開できます。",
      "作業フォルダのファイル・添付・HANDOFF.md は残ります。",
    ],
    confirmLabel: "履歴をクリア",
    danger: true,
  };
}

/**
 * 同じ会話で履歴世代 (payload の `historyGeneration`) が変わったか。会話の切替は比較しない
 * (sessionId を組にして持つ)。変わったら旧カーソル・旧バブル・取得中の旧ページを失効させる。
 */
export function historyClearedBetween(
  previous: { sessionId: string; generation: string },
  payload: Pick<SessionPayload, "sessionId" | "historyGeneration">,
): boolean {
  return previous.sessionId === payload.sessionId && previous.generation !== (payload.historyGeneration ?? "");
}

/**
 * 履歴クリアの resync に残る旧履歴の値を落とす。メッセージ・圧縮・未送信・実行状態は取り直した
 * 履歴と payload を正とし、旧世代の応答メタや context は載せない。
 */
export function withoutOldHistory(payload: SessionPayload): SessionPayload {
  const next: SessionPayload = {
    ...payload,
    status: "idle",
    queueDepth: 0,
    pendingSends: [],
    run: null,
    messages: [],
    compactions: [],
  };
  delete next.assistantMeta;
  delete next.context;
  return next;
}
