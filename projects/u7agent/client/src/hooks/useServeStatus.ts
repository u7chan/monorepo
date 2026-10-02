import { useCallback, useEffect, useRef, useState } from "react";
import { getServeStatus, startServe, stopServe } from "../api";
import { canApplyStatus } from "../lib/serveStatus";
import type { ServeStatus } from "../types";

/**
 * サービスの状態 (閲覧中の会話から見た値)。取得と操作の規則は docs/ui-layout.md を正とする。
 *   - 会話を切り替えたら前の会話の状態を描かない (選択中の id と要求の通し番号で古い応答を捨てる)
 *   - 応答がポーリング間隔より遅くても状態は更新される (飛行中の要求があるうちは次を発行しない)
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

/** 状態取得の期限。応答が返らないまま飛行中の印が残り、ポーリングが止まるのを防ぐ */
const SERVE_STATUS_TIMEOUT_MS = 15_000;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useServeStatus({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<ServeState>(IDLE);
  const [tracked, setTracked] = useState(sessionId);
  /** 発行した要求の通し番号。応答の適用可否を「番号の新しさ」で決める */
  const requestSeq = useRef(0);
  /** 飛行中の取得の番号。0 なら次を発行してよい (重ねて発行しない) */
  const inFlight = useRef(0);
  /** 適用済みの最新番号。古い応答を後から適用しない */
  const appliedSeq = useRef(0);
  /** 操作と会話切替が無効化した番号。これ以前の取得結果は適用しない */
  const invalidatedUpTo = useRef(0);
  const startAbort = useRef<AbortController | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // 会話を切り替えたフレームで前の会話の状態を描かず、切替前の取得結果も無効化する。
  // 印を外すだけだと A → B → A と戻ったときに最初の A の応答が再び有効になり、
  // その間に他会話へ置き換わっていれば古い状態を描いてしまう (Effect を待つと 1 フレーム古い値が出る)
  if (tracked !== sessionId) {
    setTracked(sessionId);
    setState(IDLE);
    invalidatedUpTo.current = requestSeq.current;
  }

  /**
   * 進行中の取得を捨てる。操作の前と、操作の応答を適用する直前に呼び、操作で確定した状態より
   * 古い取得結果で上書きさせない (会話 id が同じでも応答の到着順は入れ替わり得る)。
   * 会話切替も同じ扱いで、切替前の番号までを無効化する。
   */
  const invalidatePending = useCallback((): void => {
    invalidatedUpTo.current = requestSeq.current;
  }, []);

  /**
   * 取得。応答がポーリング間隔より遅くても状態は更新される:
   * 飛行中の要求があるうちは次を発行せず (古い要求を追い越さない)、返った応答は
   * 「最後に適用したものより新しい」限り適用する (最新のみを適用するゲートで飢えさせない)。
   */
  const refresh = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id || inFlight.current !== 0) return;
    const seq = (requestSeq.current += 1);
    inFlight.current = seq;
    try {
      const status = await getServeStatus(id, AbortSignal.timeout(SERVE_STATUS_TIMEOUT_MS));
      if (sessionIdRef.current !== id) return;
      if (!canApplyStatus(seq, invalidatedUpTo.current, appliedSeq.current)) return;
      appliedSeq.current = seq;
      setState((prev) => ({ ...prev, status, failed: false }));
    } catch {
      if (sessionIdRef.current !== id) return;
      if (!canApplyStatus(seq, invalidatedUpTo.current, appliedSeq.current)) return;
      appliedSeq.current = seq;
      // 取得失敗はリンクも操作も出さない状態。到達不可 (reachable: false) とは区別する
      setState((prev) => ({ ...prev, status: null, failed: true }));
    } finally {
      if (inFlight.current === seq) inFlight.current = 0;
    }
  }, []);

  // 初回と会話切替で取り直す。切替前の応答は無効化した番号と会話 id の照合で捨てる
  // (飛行中の印も外して次を許す)
  useEffect(() => {
    if (!sessionId) return;
    inFlight.current = 0;
    void refresh();
  }, [sessionId, refresh]);

  const start = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    const generation = state.status?.generation ?? null;
    const controller = new AbortController();
    startAbort.current = controller;
    invalidatePending();
    setState((prev) => ({ ...prev, starting: true, error: undefined }));
    try {
      const status = await startServe({ sessionId: id, generation }, controller.signal);
      if (sessionIdRef.current !== id) return;
      // 操作中に始まった取得より操作の結果を優先する
      invalidatePending();
      setState({ status, failed: false, starting: false, error: undefined });
    } catch (error) {
      if (sessionIdRef.current !== id) return;
      // 押した後の失敗は理由を出し、状態はサーバーの値を取り直す (停止中へ戻る)
      setState((prev) => ({ ...prev, starting: false, error: messageFor(error) }));
      await refresh();
    } finally {
      if (startAbort.current === controller) startAbort.current = null;
    }
  }, [invalidatePending, refresh, state.status?.generation]);

  const stop = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!id) return;
    invalidatePending();
    setState((prev) => ({ ...prev, error: undefined }));
    try {
      const status = await stopServe({ sessionId: id, generation: state.status?.generation ?? null });
      if (sessionIdRef.current !== id) return;
      invalidatePending();
      setState({ status, failed: false, starting: false, error: undefined });
    } catch (error) {
      if (sessionIdRef.current !== id) return;
      setState((prev) => ({ ...prev, error: messageFor(error) }));
      await refresh();
    }
  }, [invalidatePending, refresh, state.status?.generation]);

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
