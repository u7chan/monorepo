import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { finishOnAnimationEnd } from "../lib/animationEnd";
import { Sidebar, type SidebarProps } from "./Sidebar";

export type NavSheetProps = Omit<SidebarProps, "onClose"> & {
  /** 閉じ切った (退場アニメの完了後に dialog が閉じた)。App はここでドロワーを unmount する */
  onClose: () => void;
};

// 起点が消えた場合の焦点復帰は docs/ui-layout.md の「左バー」を参照。
const FOCUS_FALLBACK_SELECTORS = ['[data-nav-root="docked"] button', '[aria-label="ナビゲーションを開く"]'];

const FOCUS_IN_DIALOG_SELECTORS = ["button:not([disabled])"];

// 非表示の要素の focus() は成功しないため、移せたかを activeElement で確認する。
function focusFirstAvailable(root: ParentNode, selectors: readonly string[]): void {
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      element.focus();
      if (document.activeElement === element) return;
    }
  }
}

export function NavSheet({ mode, onClose, ...sidebarProps }: NavSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [closing, setClosing] = useState(false);
  // 退場アニメと unmount が済んでから実行する操作 (ドロワーを閉じた後にモーダルを開く導線)
  const afterCloseRef = useRef<(() => void) | null>(null);

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
        if (document.activeElement === previous) return;
      }
      focusFirstAvailable(document, FOCUS_FALLBACK_SELECTORS);
    };
  }, []);

  // モードの切替 (設定 ⇄ アプリに戻る) はドロワーを開いたまま中身を入れ替える契約なので、
  // 押した項目が unmount して focus が body へ落ちる。開いている間は dialog の中へ引き戻す
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open || dialog.contains(document.activeElement)) return;
    focusFirstAvailable(dialog, FOCUS_IN_DIALOG_SELECTORS);
  }, [mode]);

  // 幅を広げて docked へ戻ると App はドロワーを直接 unmount する (dialog の close が来ない)。待たせた操作を
  // ここで拾わないと、押した New Project が追加ダイアログを開かないまま消える
  useEffect(() => () => afterCloseRef.current?.(), []);

  useEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const dialog = dialogRef.current;
    if (!panel || !dialog) return;
    return finishOnAnimationEnd(panel, getComputedStyle(panel).animationDuration, () => dialog.close());
  }, [closing]);

  const requestClose = () => setClosing(true);

  // モーダルを開く順序と焦点復帰の理由は docs/ui-layout.md の「左バー」を参照。
  const closeAfter = (after: () => void) => () => {
    afterCloseRef.current = after;
    setClosing(true);
  };

  const closeThen =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      requestClose();
      action(...args);
    };

  return (
    <dialog
      ref={dialogRef}
      onClose={() => {
        const after = afterCloseRef.current;
        afterCloseRef.current = null;
        onClose();
        after?.();
      }}
      data-closing={closing}
      tabIndex={-1}
      aria-label="ナビゲーション"
      // Escape は標準挙動 (即時に閉じる) を止めて退場アニメへ載せる
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) requestClose();
      }}
      className="nav-sheet m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-transparent p-0"
    >
      <div
        ref={panelRef}
        className={cn(
          "flex h-full w-[min(320px,86vw)] flex-col border-r border-line bg-panel shadow-panel",
          closing ? "animate-drawer-out" : "animate-drawer",
        )}
      >
        <Sidebar
          variant="sheet"
          mode={mode}
          onClose={requestClose}
          {...sidebarProps}
          newChat={closeThen(sidebarProps.newChat)}
          selectSession={closeThen(sidebarProps.selectSession)}
          onNewProject={closeAfter(sidebarProps.onNewProject)}
          onOpenSettingsSection={closeThen(sidebarProps.onOpenSettingsSection)}
        />
      </div>
    </dialog>
  );
}
