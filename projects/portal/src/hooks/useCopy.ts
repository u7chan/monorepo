import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copyToClipboard";

/**
 * コピー完了のフィードバックを一定時間だけ保持する。
 * 失敗時は成功表示にしない (以前のクリップボード内容を成功と誤認させるため)。
 */
export function useCopy(resetMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    return () => {
      seqRef.current += 1;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string) => {
      const seq = ++seqRef.current;
      try {
        await copyToClipboard(text);
      } catch (error) {
        console.error("クリップボードへのコピーに失敗しました", error);
        return;
      }
      // 待機中に新しいコピー要求があれば古い結果は破棄する
      if (seq !== seqRef.current) {
        return;
      }
      setCopied(true);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );

  return { copied, copy };
}

export default useCopy;
