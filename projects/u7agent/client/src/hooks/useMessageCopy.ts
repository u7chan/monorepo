import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copyToClipboard";
import { createGenerationTracker } from "./requestGate";

/** 失敗の通知を残す時間。成功 (2 秒) より長く取り、実機でも理由を読めるようにする */
const FAILURE_RESET_MS = 8000;

/**
 * コピーの結果表示。結果を所有する部品が消えたら (会話の切替で remount されたら) 世代を進め、
 * 未完了の Promise の成否とタイマーを捨てる。古い結果を次の会話の表示に適用しない。
 */
export function useMessageCopy(resetMs = 2000, failureResetMs = FAILURE_RESET_MS) {
  const [copiedId, setCopiedId] = useState("");
  const [failure, setFailure] = useState<{ id: string; detail: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gateRef = useRef(createGenerationTracker());

  useEffect(() => {
    const gate = gateRef.current;
    return () => {
      gate.invalidate();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (failureTimerRef.current !== null) clearTimeout(failureTimerRef.current);
    };
  }, []);

  const copyMessage = useCallback(
    async (text: string, id: string) => {
      const gate = gateRef.current;
      const token = gate.begin();
      setFailure(null);
      try {
        await copyToClipboard(text);
      } catch (error) {
        // 失敗時は成功表示にしない (以前のクリップボード内容を成功と誤認させるため)
        console.error("クリップボードへのコピーに失敗しました", error);
        if (!gate.holds(token)) return;
        setCopiedId("");
        setFailure({ id, detail: error instanceof Error ? error.message : String(error) });
        if (failureTimerRef.current !== null) clearTimeout(failureTimerRef.current);
        failureTimerRef.current = setTimeout(() => setFailure(null), failureResetMs);
        return;
      }
      // 待機中に新しいコピー要求があれば古い結果は破棄する
      if (!gate.holds(token)) return;
      setFailure(null);
      setCopiedId(id);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedId(""), resetMs);
    },
    [resetMs, failureResetMs],
  );

  /** 失敗の内訳。未指定は「その id は失敗していない」 */
  const copyFailure = useCallback(
    (id: string) => (failure === null || failure.id !== id ? undefined : failure.detail),
    [failure],
  );

  return {
    copiedId,
    copyMessage,
    copyFailure,
  };
}
