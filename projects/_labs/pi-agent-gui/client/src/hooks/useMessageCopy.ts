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

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copyMessage = useCallback(
    async (text: string, id: string) => {
      setCopiedId(id);
      try {
        await copyToClipboard(text);
      } catch (error) {
        console.error("クリップボードへのコピーに失敗しました", error);
      } finally {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopiedId(""), resetMs);
      }
    },
    [resetMs],
  );

  return {
    copiedId,
    copyMessage,
  };
}
