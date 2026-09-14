import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copyToClipboard";

export function useMessageCopy(resetMs = 2000) {
  const [copiedId, setCopiedId] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    return () => {
      seqRef.current += 1;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copyMessage = useCallback(
    async (text: string, id: string) => {
      const seq = ++seqRef.current;
      try {
        await copyToClipboard(text);
      } catch (error) {
        // 失敗時は成功表示にしない (以前のクリップボード内容を成功と誤認させるため)
        console.error("クリップボードへのコピーに失敗しました", error);
        return;
      }
      // 待機中に新しいコピー要求があれば古い結果は破棄する
      if (seq !== seqRef.current) return;
      setCopiedId(id);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedId(""), resetMs);
    },
    [resetMs],
  );

  return {
    copiedId,
    copyMessage,
  };
}
