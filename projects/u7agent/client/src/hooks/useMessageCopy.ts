import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copyToClipboard";
import { createCopyResultController, type CopyResultSnapshot } from "../lib/copyResult";

/** 失敗の通知を残す時間。成功 (2 秒) より長く取り、実機でも理由を読めるようにする */
const FAILURE_RESET_MS = 8000;

/**
 * コピーの結果表示。結果の適用可否とタイマーは `client/src/lib/copyResult.ts` の controller が持ち、
 * ここは React の state へ写して返すだけにする。`owner` (会話 ID など) が変わったら controller が
 * 未完了のコピーを失効させるので、所有部品が remount されない面でも前の所有者の結果を残さない。
 */
export function useMessageCopy(owner = "", resetMs = 2000, failureResetMs = FAILURE_RESET_MS) {
  const [state, setState] = useState<CopyResultSnapshot>({ copiedId: "", failure: null });
  const controllerRef = useRef<ReturnType<typeof createCopyResultController> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createCopyResultController({
      copy: copyToClipboard,
      onChange: setState,
      resetMs,
      failureResetMs,
    });
  }
  const controller = controllerRef.current;
  // 描画中の同期呼び出しにするのは、所有者が変わった描画で古い結果を出さないため。値が同じ間は何もしない
  controller.setOwner(owner);

  // 所有部品の破棄 (会話の切替 / 面を閉じる) で、未完了の Promise の結果とタイマーを捨てる
  useEffect(() => () => controller.invalidate(), [controller]);

  const copyMessage = useCallback((text: string, id: string) => controller.copy(text, id), [controller]);
  /** 失敗の内訳。未指定は「その id は失敗していない」 */
  const copyFailure = useCallback(
    (id: string) => (state.failure === null || state.failure.id !== id ? undefined : state.failure.detail),
    [state.failure],
  );

  return {
    copiedId: state.copiedId,
    copyMessage,
    copyFailure,
  };
}
