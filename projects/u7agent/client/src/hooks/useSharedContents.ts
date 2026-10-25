import { useCallback, useEffect, useRef, useState } from "react";
import { createSharedContent, getSharedContent, getSharedContentPreview, getSharedContents } from "../api";
import { sharedContentCreateBody, SHARE_POLL_MS, sharePollPlan, withSharedContent } from "../lib/sharedContents";
import type { SharedContentPreviewResponse, SharedContentResponse } from "../types";

/**
 * 公開前のプレビューの状態。取得中 / 失敗 / 成功を分け、失敗しても公開は塞がない (補助情報として扱う)。
 */
export type SharePreviewState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; preview: SharedContentPreviewResponse };

/**
 * 共有ダイアログの state。この会話の共有物だけを扱い、全共有物の一覧は持たない。
 * 公開は非同期なので `publishing` の間だけ状態を読み直し、終端は `status` と `lastError` の組で読む。
 * ダイアログを閉じると unmount し、開き直しは一覧の GET から復元する（画面側で状態を持ち越さない）。
 */
export interface SharedContentsState {
  items: SharedContentResponse[];
  /** 一覧の初回取得中。空の一覧と区別する */
  loading: boolean;
  /** 一覧の取得に失敗した。空の一覧と区別する */
  failed: boolean;
  /** 直前に受付した共有物。結果の表示とポーリングの対象 */
  activeId: string | null;
  /** 受付（POST）の失敗理由。資格情報の未登録などは BFF の固定文言をそのまま出す */
  error: string | undefined;
  submitting: boolean;
}

const INITIAL: SharedContentsState = {
  items: [],
  loading: true,
  failed: false,
  activeId: null,
  error: undefined,
  submitting: false,
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSharedContents({ sessionId, directory }: { sessionId: string; directory: string }) {
  const [state, setState] = useState<SharedContentsState>(INITIAL);
  // プレビューはダイアログを開いた時点の見え方。公開の成否とは別に持つ (画面は状態を持ち越さない)
  const [preview, setPreview] = useState<SharePreviewState>({ status: "loading" });
  /** 発行した取得の通し番号。遅れて届いた古い応答を適用しない */
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  /** ポーリングを重ねない（応答が間隔より遅いときに要求が積み上がらない） */
  const inFlight = useRef(false);
  /**
   * 応答を適用してよい会話。同じ作業フォルダの別会話へ移っても `activeId` を持ち越すと、
   * 新しい会話の一覧に前の会話の結果が混ざるため、切替で状態ごと捨てる。
   */
  const sessionRef = useRef(sessionId);
  const [tracked, setTracked] = useState(sessionId);
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setState(INITIAL);
    requestSeq.current = 0;
    appliedSeq.current = 0;
    inFlight.current = false;
  }
  sessionRef.current = sessionId;

  const loadList = useCallback(async (): Promise<void> => {
    const session = sessionId;
    const seq = (requestSeq.current += 1);
    try {
      const { items } = await getSharedContents(session);
      if (sessionRef.current !== session) return;
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      setState((prev) => ({ ...prev, items, loading: false, failed: false }));
    } catch {
      if (sessionRef.current !== session) return;
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      // 一覧は残したまま失敗だけを示す（一瞬の失敗で読めた URL を捨てない）
      setState((prev) => ({ ...prev, loading: false, failed: true }));
    }
  }, [sessionId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // ダイアログを開いた時点の見え方を取る。取り直しは開き直しで行う (公開中に古い一覧を混ぜない)
  useEffect(() => {
    const session = sessionId;
    let cancelled = false;
    setPreview({ status: "loading" });
    getSharedContentPreview({ sessionId: session, directory })
      .then((value) => {
        if (!cancelled && sessionRef.current === session) setPreview({ status: "ready", preview: value });
      })
      .catch((error: unknown) => {
        if (!cancelled && sessionRef.current === session) setPreview({ status: "failed", message: messageFor(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, directory]);

  /** 受付して公開を開始する。202 の後に一覧を取り直し、以降は状態をポーリングする */
  const share = useCallback(
    async (directory: string, name = ""): Promise<void> => {
      const session = sessionId;
      setState((prev) => ({ ...prev, submitting: true, error: undefined }));
      try {
        const accepted = await createSharedContent(sharedContentCreateBody({ sessionId: session, directory, name }));
        if (sessionRef.current !== session) return;
        setState((prev) => ({ ...prev, submitting: false, activeId: accepted.id }));
        await loadList();
      } catch (error) {
        if (sessionRef.current !== session) return;
        setState((prev) => ({ ...prev, submitting: false, error: messageFor(error) }));
      }
    },
    [sessionId, loadList],
  );

  const plan = sharePollPlan(state.activeId, state.items);
  const pollDetailId = plan.detailId ?? "";
  const pollList = plan.list;

  useEffect(() => {
    if (pollDetailId === "" && !pollList) return;
    const session = sessionId;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        if (pollDetailId !== "") {
          try {
            const item = await getSharedContent(pollDetailId);
            if (!cancelled && sessionRef.current === session) {
              setState((prev) => ({ ...prev, items: withSharedContent(prev.items, item) }));
            }
          } catch {
            // 次のティックで再試行する。失敗は一覧側の表示（failed）に閉じる
          }
        }
        // 受付した 1 件の詳細を追っている間も、一覧の他の進行中を止めたままにしない
        if (pollList) await loadList();
      } finally {
        inFlight.current = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, SHARE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollDetailId, pollList, sessionId, loadList]);

  return { ...state, preview, share, reload: loadList };
}

export type SharedContentsController = ReturnType<typeof useSharedContents>;
