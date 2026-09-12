import { useEffect, useRef } from "react";
import { Sidebar, type SidebarProps } from "./Sidebar";

export type NavSheetProps = SidebarProps & {
  onClose: () => void;
};

/**
 * モバイルのナビゲーション。Sidebar を drawer として開く。
 * モーダル dialog にすることで、背面の inert 化と Escape での終了を標準挙動に任せる。
 */
export function NavSheet({ onClose, ...sidebarProps }: NavSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** 開く前にフォーカスしていた要素 (閉じたときに戻す) */
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      // 直前の cleanup でフォーカスが背面へ戻されている (StrictMode)
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      tabIndex={-1}
      aria-label="ナビゲーション"
      // パネル外 (dialog 自身) のクリックで閉じる。背景の暗転は dialog 全面で行う。
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-backdrop p-0"
    >
      <div className="animate-drawer flex h-full w-[min(320px,86vw)] flex-col border-r border-line bg-panel shadow-panel">
        <Sidebar variant="sheet" onClose={onClose} {...sidebarProps} />
      </div>
    </dialog>
  );
}
