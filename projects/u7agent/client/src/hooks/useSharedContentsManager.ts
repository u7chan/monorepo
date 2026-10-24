import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  deleteSharedContent,
  getAllSharedContents,
  publishSharedContent,
  resumeSharedContent,
  stopSharedContent,
} from "../api";
import { SHARE_POLL_MS, type SharedContentBusyKind } from "../lib/sharedContents";
import type { SharedContentResponse } from "../types";

/**
 * 設定 → 共有 → 共有コンテンツ の一覧。共有ダイアログの `useSharedContents` とは別物で、
 * 会話では絞らず、受付 1 件の追跡もしない（一覧全体を状態で読み直す）。
 * 一覧の取得失敗は `failed`、1 件の操作失敗は `error` に分ける。どちらも BFF の固定文言をそのまま持つ。
 */
export interface SharedContentsManagerState {
  items: SharedContentResponse[];
  /** 初回の取得中。空の一覧と区別する */
  loading: boolean;
  /** 一覧の取得に失敗した。手元の一覧は残す */
  failed: boolean;
  /** 一覧の取得失敗のうち BFF が返した固定文言。通信断など BFF の応答が無いときは null */
  listError: string | null;
  /** 再読み込みの実行中。ポーリングでは立てない */
  reloading: boolean;
  /** 操作中の共有物。同じ id の二重操作を止める */
  busy: { id: string; kind: SharedContentBusyKind }[];
  /** 直前に失敗した 1 件の操作。成功するか次の操作を始めるまで残す */
  error: { id: string; message: string } | null;
}

const INITIAL: SharedContentsManagerState = {
  items: [],
  loading: true,
  failed: false,
  listError: null,
  reloading: false,
  busy: [],
  error: null,
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSharedContentsManager() {
  const [state, setState] = useState<SharedContentsManagerState>(INITIAL);
  /** 発行した取得の通し番号。遅れて届いた古い応答を適用しない */
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  /** ポーリングを重ねない（応答が間隔より遅いときに要求が積み上がらない） */
  const pollInFlight = useRef(false);
  /** 同じ id の二重操作を同期的に止める（state の反映は 1 render 遅れる） */
  const busyIds = useRef(new Set<string>());

  const loadList = useCallback(async (): Promise<void> => {
    const seq = (requestSeq.current += 1);
    try {
      const { items } = await getAllSharedContents();
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      setState((prev) => ({ ...prev, items, loading: false, failed: false, listError: null }));
    } catch (error) {
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      // 一覧は残したまま失敗だけを示す（一瞬の失敗で読めた URL を捨てない）。
      // BFF が固定文言を返したときだけ、それをそのまま画面へ渡す
      setState((prev) => ({
        ...prev,
        loading: false,
        failed: true,
        listError: error instanceof ApiError ? error.message : null,
      }));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const reload = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, reloading: true, error: null }));
    try {
      await loadList();
    } finally {
      setState((prev) => ({ ...prev, reloading: false }));
    }
  }, [loadList]);

  /**
   * 1 件の操作。成功・失敗のどちらでも一覧を読み直して、API が確定させた状態へ追随する。
   * 失敗の文言は BFF の `error`（ApiError.message）をそのまま出し、ここで言い換えない。
   */
  const runAction = useCallback(
    async (id: string, kind: SharedContentBusyKind, run: () => Promise<unknown>, after?: () => void): Promise<void> => {
      if (busyIds.current.has(id)) return;
      busyIds.current.add(id);
      setState((prev) => ({ ...prev, busy: [...prev.busy, { id, kind }], error: null }));
      try {
        await run();
        after?.();
      } catch (error) {
        setState((prev) => ({ ...prev, error: { id, message: messageFor(error) } }));
      } finally {
        // 操作が終わったら操作中を解く。一覧の読み直しは操作ではないので、取得が遅れても操作を止め続けない
        busyIds.current.delete(id);
        setState((prev) => ({ ...prev, busy: prev.busy.filter((entry) => entry.id !== id) }));
      }
      await loadList();
    },
    [loadList],
  );

  const update = useCallback((id: string) => runAction(id, "update", () => publishSharedContent(id)), [runAction]);
  const retry = useCallback((id: string) => runAction(id, "retry", () => publishSharedContent(id)), [runAction]);
  const stop = useCallback((id: string) => runAction(id, "stop", () => stopSharedContent(id)), [runAction]);
  const resume = useCallback((id: string) => runAction(id, "resume", () => resumeSharedContent(id)), [runAction]);

  const remove = useCallback(
    (id: string) =>
      runAction(
        id,
        "delete",
        () => deleteSharedContent(id),
        () => {
          // provider の成功後なので即座に消す。進行中の一覧取得が古い行を戻さないよう、先に失効させる
          appliedSeq.current = ++requestSeq.current;
          setState((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== id) }));
        },
      ),
    [runAction],
  );

  const publishing = state.items.some((item) => item.status === "publishing");
  useEffect(() => {
    if (!publishing) return;
    const timer = setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void loadList().finally(() => {
        pollInFlight.current = false;
      });
    }, SHARE_POLL_MS);
    return () => clearInterval(timer);
  }, [publishing, loadList]);

  return {
    ...state,
    reload,
    update,
    retry,
    stop,
    resume,
    remove,
  };
}

export type SharedContentsManager = ReturnType<typeof useSharedContentsManager>;
