import { useEffect, useRef } from "react";
import { Sidebar, type SidebarProps } from "./Sidebar";

export type NavSheetProps = SidebarProps & {
  onClose: () => void;
};

/**
 * 起点が切れていた / 隠れていたときの受け皿。docked の Sidebar の先頭操作要素と、いま表示されている ☰
 * (画面遷移でチャットが `display: none` になると、☰ は DOM に残るが focus を受け取れない)
 */
const FOCUS_FALLBACK_SELECTORS = ['[data-nav-root="docked"] button', '[aria-label="ナビゲーションを開く"]'];

/**
 * focus を移せる最初の候補へ移す。非表示の要素では `focus()` が何もしないため、実際に移せたか
 * (`document.activeElement`) で判定する。どの候補にも移せなければ何もしない (body のままにする)。
 */
function focusFirstAvailable(selectors: readonly string[]): void {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      element.focus();
      if (document.activeElement === element) return;
    }
  }
}

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
        // 設定ページへ移ると起点 (Topbar / CompactBar の ☰) は display: none になり focus を受け取れない。
        // ここで戻すのを諦めると、閉じた dialog の後始末で focus が body へ落ちる
        if (document.activeElement === previous) return;
      }
      // 幅を広げて ☰ ごと消えた場合は docked になった Sidebar へ、画面遷移で隠れた場合は
      // 表示されている ☰ へ移す (sheet の中の Sidebar は選択子で除外する)
      focusFirstAvailable(FOCUS_FALLBACK_SELECTORS);
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
