// Sheet - 背面を止めて出すパネル。小さい画面では下から、広い画面では中央に現れる
//
// <dialog> の showModal() を使う。フォーカスの封じ込め・Esc・背面の inert 化・閉じたときの
// フォーカス復帰をブラウザが担うため、自前で組むより漏れが少ない (以前のポップオーバーは
// これらを手書きしていた)。閉じるときだけは、動きが終わるまで dialog を残す。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  /** 取り消しを求める確認は alertdialog にして、開いた時点で内容を読み上げさせる */
  role?: "dialog" | "alertdialog";
  children: ReactNode;
}

type Phase = "closed" | "open" | "closing";

// animationend が届かない環境 (タブが裏にあるときなど) でも、dialog を残したままにしない
const CLOSE_FALLBACK_MS = 400;

export function Sheet({
  open,
  onClose,
  labelledBy,
  describedBy,
  role = "dialog",
  children,
}: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");

  useEffect(() => {
    setPhase((current) => (open ? "open" : current === "open" ? "closing" : current));
  }, [open]);

  const finishClosing = useCallback(() => {
    dialogRef.current?.close();
    setPhase("closed");
  }, []);

  useEffect(() => {
    if (phase !== "closing") {
      return;
    }

    const timer = window.setTimeout(finishClosing, CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [phase, finishClosing]);

  // 描画前に開く。useEffect だと、閉じた dialog が 1 フレーム映る
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (phase !== "open" || !dialog || dialog.open) {
      return;
    }

    dialog.showModal();
    // 既定では先頭の操作が選ばれる。確認では、押し間違えても安全な取り消しを先に選ばせる
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [phase]);

  if (phase === "closed") {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      role={role}
      className="sheet"
      data-phase={phase}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        // Esc。dialog を直接閉じず、親の状態を経由して閉じる動きを通す
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // ブラウザ側が閉じた場合 (Esc の連打など) も、親の状態と食い違わせない
        if (phase === "open") {
          onClose();
        }
        setPhase("closed");
      }}
      onClick={(event) => {
        // パネルの外 (背景) を押したとき。dialog 自体は画面全体を覆う透明な箱
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="sheet-panel"
        onAnimationEnd={(event) => {
          if (phase === "closing" && event.target === event.currentTarget) {
            finishClosing();
          }
        }}
      >
        {children}
      </div>
    </dialog>
  );
}

export default Sheet;
