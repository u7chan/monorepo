import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copyToClipboard";

/**
 * ホバー表示のコピーボタン用フック。
 * 直前にコピーした要素の id を copiedId に保持し、resetMs 経過でクリアする。
 * コピー可否表示は copiedId === 対象の id で判定する。
 */
export function useMessageCopy(resetMs = 2000) {
  const [copiedId, setCopiedId] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 進行中のコピー要求を識別する。完了時に最新要求かどうかの判定に使う */
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
      // 待ち時間中に新しいコピー要求があれば古い結果は破棄する
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
