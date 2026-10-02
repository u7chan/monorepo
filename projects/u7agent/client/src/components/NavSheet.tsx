import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { Sidebar, type SidebarProps } from "./Sidebar";

export type NavSheetProps = Omit<SidebarProps, "onClose"> & {
  /** 閉じ切った (退場アニメの完了後に dialog が閉じた)。App はここでドロワーを unmount する */
  onClose: () => void;
};

/**
 * 起点が切れていた / 隠れていたときの受け皿。docked の Sidebar の先頭操作要素と、いま表示されている ☰
 * (画面遷移でチャットが `display: none` になると、☰ は DOM に残るが focus を受け取れない)
 */
const FOCUS_FALLBACK_SELECTORS = ['[data-nav-root="docked"] button', '[aria-label="ナビゲーションを開く"]'];

/** モードの切替で中身が入れ替わったときに focus を引き戻す先。sheet はブランド行の「閉じる」 */
const FOCUS_IN_DIALOG_SELECTORS = ["button:not([disabled])"];

/**
 * focus を移せる最初の候補へ移す。非表示の要素では `focus()` が何もしないため、実際に移せたか
 * (`document.activeElement`) で判定する。どの候補にも移せなければ何もしない (body のままにする)。
 */
function focusFirstAvailable(root: ParentNode, selectors: readonly string[]): void {
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      element.focus();
      if (document.activeElement === element) return;
    }
  }
}

/**
 * モーダル dialog にして、背面の inert 化と Escape での終了を標準挙動に任せる。Escape だけは `cancel` で
 * 受けて標準挙動を止め、退場アニメへ載せ替える (即時に閉じるとアニメが出ない)
 */
export function NavSheet({ mode, onClose, ...sidebarProps }: NavSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // 退場アニメの最中か。閉じる要求では unmount せず、まずパネルを抜けさせてから dialog を閉じる
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
        // 設定ページへ移ると起点 (Topbar / CompactBar の ☰) は display: none になり focus を受け取れない。
        // ここで戻すのを諦めると、閉じた dialog の後始末で focus が body へ落ちる
        if (document.activeElement === previous) return;
      }
      // 幅を広げて ☰ ごと消えた場合は docked になった Sidebar へ、画面遷移で隠れた場合は
      // 表示されている ☰ へ移す (sheet の中の Sidebar は選択子で除外する)
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

  // 閉じるのは本則では animationend (panel の onAnimationEnd) だが、animation を切る環境 (user style /
  // 拡張機能) では animationend が来ず、Escape も止めているためモーダルを閉じられなくなる。CSS の長さを読んで
  // その倍 + 余裕を待つ保険を置く (アニメーションが動くときは animationend のほうが先に来る)
  useEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const dialog = dialogRef.current;
    if (!panel || !dialog) return;
    const duration = Number.parseFloat(getComputedStyle(panel).animationDuration) * 1000;
    const timer = setTimeout(() => dialog.close(), duration * 2 + 100);
    return () => clearTimeout(timer);
  }, [closing]);

  /** 閉じる要求 (× / 背景クリック / Escape / 項目の選択) の唯一の入口。dialog は退場アニメの後に閉じる */
  const requestClose = () => setClosing(true);

  /**
   * モーダル (ProjectDialog) を開く導線用の閉じる要求。開くのを退場後に遅らせるのは、退場中に開くとその
   * モーダルが戻り先として掴むドロワー内の要素が unmount で消え、モーダルを閉じた後に focus が body へ落ちるため。
   */
  const closeAfter = (after: () => void) => () => {
    afterCloseRef.current = after;
    setClosing(true);
  };

  /**
   * ドロワーの項目を押したときに使う。選んだ内容 (セッションなど) は退場アニメを待たずに進める
   * (待つと、選んだ画面が出るまで 180ms 遅れる)。
   */
  const closeThen =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      requestClose();
      action(...args);
    };

  return (
    <dialog
      ref={dialogRef}
      // 退場後に実行する操作は unmount と同じコミットで走らせ、開いたモーダルの戻り先がドロワーの焦点復帰より
      // 前にならないようにする
      onClose={() => {
        const after = afterCloseRef.current;
        afterCloseRef.current = null;
        onClose();
        after?.();
      }}
      // 背景の暗転をパネルと同じ 180ms で薄くする印 (styles/index.css の .nav-sheet)
      data-closing={closing}
      tabIndex={-1}
      aria-label="ナビゲーション"
      // Escape は標準挙動 (即時に閉じる) を止めて退場アニメへ載せる
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      // パネル外 (dialog 自身) のクリックで閉じる。背景の暗転は dialog::backdrop が担う
      onClick={(event) => {
        if (event.target === dialogRef.current) requestClose();
      }}
      className="nav-sheet m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-transparent p-0"
    >
      <div
        ref={panelRef}
        // ここで dialog を閉じるため、この animation を切ると (prefers-reduced-motion など) 閉じられなくなる。
        // animationend は子の animation からも上がるので、自分の分だけを見る
        onAnimationEnd={(event) => {
          if (!closing || event.target !== event.currentTarget) return;
          dialogRef.current?.close();
        }}
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
          // 選んだらドロワーを閉じる。削除とリネームは確認 / 入力の後も開いたまま残す (連続操作しうる)。
          // モードの切替 (設定 / アプリに戻る) とプロジェクトの折りたたみは選択ではないので閉じない
          newChat={closeThen(sidebarProps.newChat)}
          selectSession={closeThen(sidebarProps.selectSession)}
          onNewProject={closeAfter(sidebarProps.onNewProject)}
          onOpenSettingsSection={closeThen(sidebarProps.onOpenSettingsSection)}
        />
      </div>
    </dialog>
  );
}
