import type { Dispatch, RefObject } from "react";
import type { ConfirmRequest, PromptRequest } from "../lib/confirmDialog";
import { renameInputValue } from "../lib/confirmDialog";
import { messageFor } from "../lib/errors";
import { missingLinkNote, type SessionOpenResult } from "../lib/notifications";
import { HISTORY_CLEAR_CLEANUP_NOTE, sessionHistoryClearConfirmRequest } from "../lib/sessionHistoryClear";
import { sessionDeleteConfirmRequest, sessionRenameRequest } from "../lib/sidebarRowMenu";
import { sessionsInSpace } from "../lib/spaceSessions";
import type {
  SessionHistoryClearResponse,
  SessionMoveResponse,
  SessionPayload,
  SessionSummary,
  SessionTitleResponse,
} from "../types";
import type { ChatAction } from "../lib/chatState";
import type { SessionHistory } from "./sessionHistory";
import { nextAfterRemoval } from "./sessionFallback";

/** 会話の選択。`useSessions` の同名の手順をそのまま受け取る (判定は呼び出し側が持つ) */
export type SelectSession = (
  id: string,
  isCurrent?: () => boolean,
  options?: { fallbackOnFailure?: boolean; discardHistory?: boolean },
) => Promise<SessionOpenResult>;

/** 一覧と選択を読む操作の共通の依存。await を挟んだ後も ref から最新値を読む */
export type SessionListDeps = {
  /** 表示中の会話。await を挟んだ後の判定に使う */
  sessionIdRef: RefObject<string>;
  /** 一覧の最新値。await を挟む処理が state を待たずに読む */
  sessionsRef: RefObject<SessionSummary[]>;
  /** 一覧の取り直し。飛んでいる古い一覧を追い越す */
  refreshSessionsNow: () => Promise<SessionSummary[] | null>;
};

export type RenameSessionDeps = {
  sessionsRef: RefObject<SessionSummary[]>;
  prompt: (request: PromptRequest) => Promise<string | null>;
  /** 応答の正規化後タイトルを一覧へ反映する */
  applyTitle: (id: string, title: string) => void;
  rename: (id: string, title: string) => Promise<SessionTitleResponse>;
  dispatch: Dispatch<ChatAction>;
};

/**
 * 会話タイトルの変更。初期値は現在のタイトルで、取り消し・空・未変更はサーバーへ送らない。
 * 応答のタイトルを一覧へ反映する (ヘッダの表示も一覧から引くため、これだけで画面が追従する)。
 * 失敗は楽観反映をしないので、理由だけを状態行へ出す。
 */
export async function renameSessionTitle(id: string, deps: RenameSessionDeps): Promise<void> {
  const current = deps.sessionsRef.current.find((item) => item.sessionId === id)?.title ?? "";
  const next = renameInputValue(await deps.prompt(sessionRenameRequest(current)), current);
  if (next === undefined) return;
  try {
    const result = await deps.rename(id, next);
    deps.applyTitle(result.sessionId, result.title);
  } catch (error) {
    deps.dispatch({ type: "setActivity", text: `セッション名を変更できませんでした。${messageFor(error)}` });
  }
}

export type DeleteSessionDeps = SessionListDeps & {
  /** 現在のスペース。移り先を全スペースの一覧から選ばない */
  spaceIdRef: RefObject<string>;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  remove: (id: string) => Promise<unknown>;
  selectSession: SelectSession;
  /** 未作成チャットへ移す */
  newChat: () => void;
};

/**
 * 会話の削除。確認は現在のタイトルで行い、確定後は成否に関わらず一覧を取り直す
 * (削除の応答が失われても、消えたかどうかを一覧で確かめてから移り先を決める)。
 */
export async function removeSession(id: string, deps: DeleteSessionDeps): Promise<void> {
  const title = deps.sessionsRef.current.find((item) => item.sessionId === id)?.title ?? "";
  if (!(await deps.confirm(sessionDeleteConfirmRequest(title)))) return;
  try {
    await deps.remove(id);
  } catch (error) {
    console.error(error);
  }
  const list = await deps.refreshSessionsNow();
  if (id !== deps.sessionIdRef.current) return;
  // 取得できなかったときは前回の一覧から選ぶ (消えたセッションを掴んでも selectSession が移す)
  const next = nextAfterRemoval(sessionsInSpace(list ?? deps.sessionsRef.current, deps.spaceIdRef.current));
  if (next.kind === "select") await deps.selectSession(next.sessionId);
  else deps.newChat();
}

export type ForkSessionDeps = {
  fork: (id: string, request: { agentId?: string }) => Promise<SessionPayload>;
  refreshSessionsNow: () => Promise<SessionSummary[] | null>;
};

/**
 * 会話を分岐する。子は親の末尾までの履歴を持ち、作業フォルダ / 添付は親と共有する。
 * 成功したら一覧を取り直し、子の payload を返す (子を開くかは App が選択の世代で決める)。
 * 失敗は理由をダイアログへ返すため投げ直す。
 */
export async function branchSession(
  id: string,
  request: { agentId?: string },
  deps: ForkSessionDeps,
): Promise<SessionPayload> {
  const child = await deps.fork(id, request);
  await deps.refreshSessionsNow();
  return child;
}

export type HandoffSessionDeps = {
  handoff: (id: string, request: { spaceId: string; agentId?: string; memo: boolean }) => Promise<SessionMoveResponse>;
  refreshSessionsNow: () => Promise<SessionSummary[] | null>;
};

/**
 * 会話を引き継ぐ。履歴は破棄され、エージェントは差し替わり、別スペースなら作業フォルダ / 添付 / cwd キーの行が
 * 移動先へ移る (不可逆)。成功したら一覧を取り直し、応答を返す (スペースの切替と会話の開き直しは
 * App が `openOwnerSession` と同じ経路で行う。一覧からの削除と同じ移り先の規則は使わない)。
 * 失敗は理由をダイアログへ返すため投げ直す。
 */
export async function moveSession(
  id: string,
  request: { spaceId: string; agentId?: string; memo: boolean },
  deps: HandoffSessionDeps,
): Promise<SessionMoveResponse> {
  // 要求元は現在のスペース (space.api の query)、移動先は body で渡す
  const result = await deps.handoff(id, request);
  await deps.refreshSessionsNow();
  return result;
}

export type ClearHistoryDeps = SessionListDeps & {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  getSession: (id: string) => Promise<SessionPayload>;
  clear: (id: string, request: { historyGeneration: string }) => Promise<SessionHistoryClearResponse>;
  selectSession: SelectSession;
  /** 同じ会話のまま履歴が入れ替わる操作の、要求世代とカーソルの持ち主 */
  history: Pick<SessionHistory, "reset" | "resetForCleanup">;
  dispatch: Dispatch<ChatAction>;
};

/**
 * 会話履歴のクリア。確認時点の履歴世代を控えてから確認し、成功したら一覧を取り直す。
 * 開いている会話は同じ id / URL のまま開き直し、旧バブルと取得中の旧ページを捨てる
 * (クリア後の再読み込みは `acceptPayload` の履歴世代の判定でも行う)。
 */
export async function clearSessionHistory(id: string, deps: ClearHistoryDeps): Promise<void> {
  const title = deps.sessionsRef.current.find((item) => item.sessionId === id)?.title ?? "";
  // 確認の対象となる履歴世代を先に控える。別タブが先にクリアしていればサーバーが 409 にする
  let generation: string;
  try {
    generation = (await deps.getSession(id)).historyGeneration ?? "";
  } catch (error) {
    deps.dispatch({ type: "setActivity", text: `会話履歴をクリアできませんでした。${messageFor(error)}` });
    return;
  }
  if (!(await deps.confirm(sessionHistoryClearConfirmRequest(title)))) return;
  let result: SessionHistoryClearResponse;
  try {
    result = await deps.clear(id, { historyGeneration: generation });
  } catch (error) {
    deps.dispatch({ type: "setActivity", text: `会話履歴をクリアできませんでした。${messageFor(error)}` });
    return;
  }
  await deps.refreshSessionsNow();
  // 開いていない会話はここまで (開いている会話の状態行を別の会話の結果で乱さない)
  if (deps.sessionIdRef.current !== id) return;
  if (!result.changed) {
    deps.dispatch({ type: "setActivity", text: "消す会話履歴はありませんでした" });
    return;
  }
  if (result.cleanupPending) {
    // 片付け待ちは開き直すと 409 になる。URL を変えずに手元の履歴だけを捨て、警告を状態行へ出す
    deps.history.resetForCleanup(id, result.historyGeneration);
    deps.dispatch({ type: "setActivity", text: HISTORY_CLEAR_CLEANUP_NOTE });
    return;
  }
  const opened = await deps.selectSession(id, undefined, { fallbackOnFailure: false, discardHistory: true });
  // 開けなかった理由は開き直しの後に出す (resync が活動表示を消すため)
  const text = opened === "opened" ? "会話履歴をクリアしました" : missingLinkNote(true, opened);
  if (text) deps.dispatch({ type: "setActivity", text });
}
