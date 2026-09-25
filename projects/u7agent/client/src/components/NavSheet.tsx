import { useEffect, useRef } from "react";
import { Sidebar, type SidebarProps } from "./Sidebar";

export type NavSheetProps = SidebarProps & {
  onClose: () => void;
};

/** 起点が消えていたときの受け皿。docked の Sidebar (dialog の中ではない) の先頭操作要素 */
const DOCKED_NAV_FOCUS_SELECTOR = '[data-nav-root="docked"] button';

/** モーダル dialog にして、背面の inert 化と Escape での終了を標準挙動に任せる */
export function NavSheet({ onClose, ...sidebarProps }: NavSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
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
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) {
        previous.focus();
        return;
      }
      // 幅を広げると ☰ ごと消える。切れた起点へ戻そうとして body へ落とさず、
      // docked になった Sidebar の先頭操作要素へ移す (sheet の中の Sidebar は選択子で除外する)
      document.querySelector<HTMLElement>(DOCKED_NAV_FOCUS_SELECTOR)?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      tabIndex={-1}
      aria-label="ナビゲーション"
      // パネル外 (dialog 自身) のクリックで閉じる。背景の暗転は dialog::backdrop が担う
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-transparent p-0"
    >
      <div className="flex h-full w-[min(320px,86vw)] animate-drawer flex-col border-r border-line bg-panel shadow-panel">
        <Sidebar variant="sheet" onClose={onClose} {...sidebarProps} />
      </div>
    </dialog>
  );
}
