import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copyToClipboard";

/** 失敗の通知を残す時間。成功 (2 秒) より長く取り、実機でも理由を読めるようにする */
const FAILURE_RESET_MS = 8000;

export function useMessageCopy(resetMs = 2000, failureResetMs = FAILURE_RESET_MS) {
  const [copiedId, setCopiedId] = useState("");
  const [failure, setFailure] = useState<{ id: string; detail: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    return () => {
      seqRef.current += 1;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (failureTimerRef.current !== null) clearTimeout(failureTimerRef.current);
    };
  }, []);

  const copyMessage = useCallback(
    async (text: string, id: string) => {
      const seq = ++seqRef.current;
      setFailure(null);
      try {
        await copyToClipboard(text);
      } catch (error) {
        // 失敗時は成功表示にしない (以前のクリップボード内容を成功と誤認させるため)
        console.error("クリップボードへのコピーに失敗しました", error);
        if (seq !== seqRef.current) return;
        setCopiedId("");
        setFailure({ id, detail: error instanceof Error ? error.message : String(error) });
        if (failureTimerRef.current !== null) clearTimeout(failureTimerRef.current);
        failureTimerRef.current = setTimeout(() => setFailure(null), failureResetMs);
        return;
      }
      // 待機中に新しいコピー要求があれば古い結果は破棄する
      if (seq !== seqRef.current) return;
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
