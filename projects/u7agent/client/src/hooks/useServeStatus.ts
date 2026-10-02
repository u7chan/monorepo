import { useCallback, useEffect, useRef, useState } from "react";
import { getServeStatus, startServe, stopServe } from "../api";
import { createRequestGate } from "./requestGate";
import type { ServeStatus } from "../types";

/**
 * サービスの状態 (閲覧中の会話から見た値)。取得と操作の規則は docs/ui-layout.md を正とする。
 *   - 会話を切り替えたら前の会話の状態を描かない (選択中の id と要求世代で古い応答を捨てる)
 *   - 取得に失敗したらリンクも操作も出さない (到達不可と区別する)
 *   - 起動は期限つきのプローブまで確定しないため、押した直後の遷移状態 (starting) を持つ
 */
export interface ServeState {
  status: ServeStatus | null;
  /** 取得に失敗した。リンクも操作も出さない */
  failed: boolean;
  /** 起動の確認待ち */
  starting: boolean;
  /** 直前の操作の失敗理由 */
  error: string | undefined;
}

const IDLE: ServeState = { status: null, failed: false, starting: false, error: undefined };

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useServeStatus({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<ServeState>(IDLE);
  const [tracked, setTracked] = useState(sessionId);
  // 会話を切り替えたフレームで前の会話の状態を描かない (Effect を待つと 1 フレーム古い値が出る)
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setState(IDLE);
  }
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const gate = useRef(createRequestGate()).current;
  const startAbort = useRef<AbortController | null>(null);

  /** 取得。古い応答 (会話切替 / 後続の要求) は捨てる */
  const refresh = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    const canApply = gate(() => sessionIdRef.current === id);
    try {
      const status = await getServeStatus(id);
      if (!canApply()) return;
      setState((prev) => ({ ...prev, status, failed: false }));
    } catch {
      if (!canApply()) return;
      // 取得失敗はリンクも操作も出さない状態。到達不可 (reachable: false) とは区別する
      setState((prev) => ({ ...prev, status: null, failed: true }));
    }
  }, [gate]);

  // 初回と会話切替で取り直す。切替前の応答は gate が捨てる
  useEffect(() => {
    if (!sessionId) return;
    void refresh();
  }, [sessionId, refresh]);

  const start = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    const generation = state.status?.generation ?? null;
    const controller = new AbortController();
    startAbort.current = controller;
    setState((prev) => ({ ...prev, starting: true, error: undefined }));
    try {
      const status = await startServe({ sessionId: id, generation }, controller.signal);
      if (sessionIdRef.current !== id) return;
      setState({ status, failed: false, starting: false, error: undefined });
    } catch (error) {
      if (sessionIdRef.current !== id) return;
      // 押した後の失敗は理由を出し、状態はサーバーの値を取り直す (停止中へ戻る)
      setState((prev) => ({ ...prev, starting: false, error: messageFor(error) }));
      await refresh();
    } finally {
      if (startAbort.current === controller) startAbort.current = null;
    }
  }, [refresh, state.status?.generation]);

  const stop = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    setState((prev) => ({ ...prev, error: undefined }));
    try {
      const status = await stopServe({ sessionId: id, generation: state.status?.generation ?? null });
      if (sessionIdRef.current !== id) return;
      setState({ status, failed: false, starting: false, error: undefined });
    } catch (error) {
      if (sessionIdRef.current !== id) return;
      setState((prev) => ({ ...prev, error: messageFor(error) }));
      await refresh();
    }
  }, [refresh, state.status?.generation]);

  /**
   * 起動の確認待ちをやめる。サーバー側の起動は続くため、状態は次回の取得で確定する
   * (「起動をやめた」ではなく「待つのをやめた」)。
   */
  const cancel = useCallback((): void => {
    startAbort.current?.abort();
    startAbort.current = null;
    setState((prev) => ({ ...prev, starting: false }));
  }, []);

  return { ...state, refresh, start, stop, cancel };
}

export type ServeController = ReturnType<typeof useServeStatus>;
