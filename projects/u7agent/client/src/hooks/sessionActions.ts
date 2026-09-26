import type { Dispatch, RefObject } from "react";
import type {
  Health,
  PostMessageResult,
  RunStatus,
  SessionCompactionResult,
  SessionSummary,
  StopResult,
} from "../types";
import type { ChatAction } from "./chatReducer";
import { runtimeStatusForError, type RuntimeStatus } from "./runtimeStatus";

/**
 * HTTP の応答として返った失敗 (400 / 409 / 500)。接続自体の失敗と区別する
 * (api.ts は location を参照するため、ここでは class ではなく status の有無を見る)。
 */
function isApiFailure(error: unknown): boolean {
  return error instanceof Error && typeof (error as { status?: unknown }).status === "number";
}

export type SendChatMessageDeps = {
  health: Health | null;
  busy: boolean;
  /** render 時の state は古くなるため、await を挟んだ後の判定に使う */
  sessionIdRef: RefObject<string>;
  /** 同一セッション内の操作世代。要求の後に権威ある状態 (終端 resync / 新しい要求) が入っていれば応答を捨てる */
  opsRef: RefObject<number>;
  /** 現在の実行状態。圧縮中の送信キューは compacting のまま見せる */
  runStatusRef: RefObject<RunStatus>;
  /** run が終わった回数 (ChatState.runEndSeq)。要求の後に run が終わっていれば、その run の値を持つ応答は古い */
  runEndSeqRef: RefObject<number>;
  ensureSession: () => Promise<string>;
  /** 一覧を取り直す。取得できなかったときは null (空の成功と区別する) */
  refreshSessions: () => Promise<SessionSummary[] | null>;
  post: (sessionId: string, text: string, attachments: string[]) => Promise<PostMessageResult>;
  /** 送信できた添付 (root 相対)。成功したときにチップを消すために使う */
  attachments?: string[];
  /** post が成功した直後のフック (チップのクリアなど) */
  onSent?: () => void;
  dispatch: Dispatch<ChatAction>;
  setSending: (value: boolean) => void;
  setRuntimeStatus: (status: RuntimeStatus) => void;
};

export async function sendChatMessage(text: string, deps: SendChatMessageDeps): Promise<void> {
  const attachments = deps.attachments ?? [];
  // 本文も添付も無い送信は投げない (添付だけの送信は許可されている)
  if ((!text && attachments.length === 0) || deps.busy) return;
  const {
    sessionIdRef,
    opsRef,
    runStatusRef,
    runEndSeqRef,
    ensureSession,
    refreshSessions,
    post,
    dispatch,
    setSending,
    setRuntimeStatus,
  } = deps;
  setSending(true);
  // 失敗時に戻すエコーの判定。ensureSession 自体の失敗ではまだエコーを出していない
  let echoed = false;
  try {
    if (deps.health && !deps.health.ready) {
      throw new Error(deps.health.error || "APIキーまたは認証設定を確認してください");
    }
    // 送信先は ensureSession の戻り値で受ける。ensureSession は refreshSessions を await するため、
    // その間に選択が切り替わると sessionIdRef を読み直した先が空になり、入力が黙って消える
    const targetId = await ensureSession();
    // 切替後は表示と別セッションになる。入力もセッションも捨てずに送信だけ続け、
    // 現在の表示のバブル / 実行状態は触らない (一覧は post 後の refreshSessions が更新する)
    const sameChat = sessionIdRef.current === targetId;
    // ローカルエコーは素の本文で先に出す (注記込みの本文は run_start が届いたときに差し替える)
    if (sameChat) {
      dispatch({ type: "localUser", text, at: Date.now() });
      echoed = true;
    }

    // 送信を始めた時点の世代と run の終了回数。応答の適用時に一致を確認する (ensureSession は選択と
    // 一覧を進めるため、これより前に読むと自分の送信の応答まで捨てる)
    const ops = opsRef.current;
    const runSeq = runEndSeqRef.current;
    const result = await post(targetId, text, attachments);
    deps.onSent?.();
    // 応答は状態の正ではない。要求の後に権威ある状態 (終端 resync / run の終了 / 新しい要求) が入った、
    // または表示が別の会話へ移った場合は、遅れて届いた queueDepth と runStatus で表示を戻さない
    // (一覧の取り直しは続ける)
    if (sameChat && opsRef.current === ops && runEndSeqRef.current === runSeq && sessionIdRef.current === targetId) {
      if (result.queued) {
        // 圧縮中の送信はキューに積まれる。表示は compacting のまま保つ (実際に走っているのは圧縮)
        const compacting = runStatusRef.current === "compacting";
        dispatch({
          type: "setRun",
          runStatus: compacting ? "compacting" : "running",
          queueDepth: result.queueDepth,
          activity: compacting
            ? `圧縮中のため待機キューに追加しました（${result.queueDepth}件目）`
            : `実行中のため待機キューに追加しました（${result.queueDepth}件目）`,
        });
      } else {
        dispatch({ type: "setRun", runStatus: "running", queueDepth: 0, activity: "実行を開始しました" });
      }
    }
    void refreshSessions();
  } catch (error) {
    // 送れなかったエコーを戻す。残すと次に同じ本文を送ったとき、その run_start が失敗分を消費する
    if (echoed) dispatch({ type: "dropLocalUser" });
    const status = runtimeStatusForError(error);
    dispatch({ type: "setActivity", text: status.detail || status.text });
    setRuntimeStatus(status);
  } finally {
    setSending(false);
  }
}

export type StopRunDeps = {
  sessionIdRef: RefObject<string>;
  /** 同一セッション内の操作世代。要求後に終端 resync が届いていれば応答を捨てる */
  opsRef: RefObject<number>;
  /** 現在の実行状態。圧縮中は応答の status で表示を戻さない (終端 resync が正) */
  runStatusRef: RefObject<RunStatus>;
  stop: (sessionId: string) => Promise<StopResult>;
  dispatch: Dispatch<ChatAction>;
};

export async function stopRun({ sessionIdRef, opsRef, runStatusRef, stop, dispatch }: StopRunDeps): Promise<void> {
  const id = sessionIdRef.current;
  if (!id) return;
  const ops = opsRef.current;
  try {
    const result = await stop(id);
    // 選択が変わった / 終端 resync や新しい要求が入った後の応答は、表示を戻すので捨てる
    if (sessionIdRef.current !== id || opsRef.current !== ops) return;
    // 圧縮中は応答の status (圧縮前の run の値) で解除せず、終端 resync / status に任せる
    if (runStatusRef.current === "compacting") return;
    dispatch({
      type: "setRun",
      runStatus: (result.status || "idle") as RunStatus,
      queueDepth: 0,
      activity: "停止要求を送信しました",
    });
  } catch (error) {
    console.error(error);
  }
}

export type CompactChatDeps = {
  sessionIdRef: RefObject<string>;
  /** 同一セッション内の操作世代。要求とともに進め、応答適用時に一致を確認する */
  opsRef: RefObject<number>;
  compact: (sessionId: string) => Promise<SessionCompactionResult>;
  dispatch: Dispatch<ChatAction>;
  setRuntimeStatus: (status: RuntimeStatus) => void;
};

/**
 * 手動圧縮。状態の正は SSE (開始 / 終端 resync と status) とし、応答は SSE が届かない場合の
 * 補助に留める。要求より後に終端 resync や別の操作が入っていたら、遅れて届いた応答で表示を戻さない。
 */
export async function compactChat({
  sessionIdRef,
  opsRef,
  compact,
  dispatch,
  setRuntimeStatus,
}: CompactChatDeps): Promise<void> {
  const id = sessionIdRef.current;
  if (!id) return;
  const ops = (opsRef.current += 1);
  try {
    await compact(id);
  } catch (error) {
    if (sessionIdRef.current !== id || opsRef.current !== ops) return;
    const status = runtimeStatusForError(error);
    dispatch({ type: "setActivity", text: status.detail || status.text });
    // 400 / 409 / 500 は操作の結果 (理由は終端 status が配る)。接続状態に倒すのは通信自体の失敗だけ
    if (!isApiFailure(error)) setRuntimeStatus(status);
  }
}
