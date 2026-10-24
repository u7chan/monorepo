import { useCallback, useEffect, useRef, useState } from "react";
import { createSharedContent, getSharedContent, getSharedContents } from "../api";
import { SHARE_POLL_MS, sharePollPlan, withSharedContent } from "../lib/sharedContents";
import type { SharedContentResponse } from "../types";

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

export function useSharedContents({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<SharedContentsState>(INITIAL);
  /** 発行した取得の通し番号。遅れて届いた古い応答を適用しない */
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  /** ポーリングを重ねない（応答が間隔より遅いときに要求が積み上がらない） */
  const inFlight = useRef(false);

  const loadList = useCallback(async (): Promise<void> => {
    const seq = (requestSeq.current += 1);
    try {
      const { items } = await getSharedContents(sessionId);
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      setState((prev) => ({ ...prev, items, loading: false, failed: false }));
    } catch {
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      // 一覧は残したまま失敗だけを示す（一瞬の失敗で読めた URL を捨てない）
      setState((prev) => ({ ...prev, loading: false, failed: true }));
    }
  }, [sessionId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  /** 受付して公開を開始する。202 の後に一覧を取り直し、以降は状態をポーリングする */
  const share = useCallback(
    async (directory: string): Promise<void> => {
      setState((prev) => ({ ...prev, submitting: true, error: undefined }));
      try {
        const accepted = await createSharedContent({ sessionId, directory });
        setState((prev) => ({ ...prev, submitting: false, activeId: accepted.id }));
        await loadList();
      } catch (error) {
        setState((prev) => ({ ...prev, submitting: false, error: messageFor(error) }));
      }
    },
    [sessionId, loadList],
  );

  const plan = sharePollPlan(state.activeId, state.items);
  const pollKind = plan?.kind ?? "none";
  const pollId = plan?.kind === "detail" ? plan.id : "";

  useEffect(() => {
    if (pollKind === "none") return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        if (pollKind === "detail") {
          const item = await getSharedContent(pollId);
          if (cancelled) return;
          setState((prev) => ({ ...prev, items: withSharedContent(prev.items, item) }));
          return;
        }
        await loadList();
      } catch {
        // 次のティックで再試行する。失敗は一覧側の表示（failed）に閉じる
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
  }, [pollKind, pollId, loadList]);

  return { ...state, share, reload: loadList };
}

export type SharedContentsController = ReturnType<typeof useSharedContents>;
