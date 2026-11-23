import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { useExitPhase } from "../hooks/useExitPhase";
import { cn } from "../lib/cn";

/** 閉じる要求の入口。X / キャンセル / 背景 / 実行成功のどの経路もこの 1 本を通す */
export type ModalDialogHandle = { requestClose: () => void };

/** 枠の形。幅・全画面・下端シートの別だけを殻が持ち、呼び出し側は中身の組み方を持つ */
export type ModalDialogFrame = "narrow" | "wide" | "sheet" | "fullscreen" | "image";

// 枠・色・余白は呼び出し側に書かせない (面ごとに少しずつ違う指定が生えるため)。layout は className で受ける
const FRAME_CLASS: Record<ModalDialogFrame, string> = {
  narrow:
    "m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel",
  wide: "m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel",
  sheet:
    "m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-panel p-0 text-ink shadow-panel singleColumn:m-0 singleColumn:mt-auto singleColumn:w-screen singleColumn:max-w-none singleColumn:rounded-b-none",
  fullscreen: "m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-panel p-0 text-ink",
  image:
    "m-0 flex h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-0 text-ink",
};

export type ModalDialogProps = {
  /** 読み上げ名 (`aria-label`) */
  label: string;
  frame: ModalDialogFrame;
  /** 中身の組み方 (flex の向き・高さの配分) だけ。枠・色・余白は frame が持つ */
  className?: string;
  /** 退場まで閉じ切った。呼び出し側はここで mount を切る (Promise の解決もここで行う) */
  onClosed: () => void;
  /**
   * 実行中は操作 (Escape / 背景クリック) による閉じる要求を捨てる。ボタンの無効化と対で使う。
   * handle 経由の閉じる (実行成功など呼び出し側が意図した経路) は busy でも通す
   */
  busy?: boolean;
  /**
   * 背景 (dialog 自身) のクリック。中央モーダルは既定で背景クリックを使わない (docs/ui-layout.md)。
   * 全画面の拡大表示だけが閉じる導線として使う
   */
  onBackgroundClick?: () => void;
  handleRef: RefObject<ModalDialogHandle | null>;
  ariaBusy?: boolean;
  children: ReactNode;
};

/**
 * 中央モーダルの殻。native `<dialog>` の標準挙動 (背面の inert 化 / Tab の拘束 / 焦点の復帰) の上に、
 * 出入りのアニメ (`data-closing` と `useExitPhase`) と閉じる要求の 1 経路を載せる。
 * 退場は「親が unmount する前に `onClosed` を待つ」形で作るので、呼び出し側の `onClose` は
 * 閉じる操作ではなく**閉じ切った後**の後片付けとして扱う。
 */
export function ModalDialog({
  label,
  frame,
  className,
  onClosed,
  busy = false,
  onBackgroundClick,
  handleRef,
  ariaBusy,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const fallbackFocusRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const closedRef = useRef(false);
  const busyRef = useRef(busy);
  const onClosedRef = useRef(onClosed);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  // 開く。showModal() は最初の操作要素へ焦点を移すため、戻し先は呼ぶ前に控える
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      // 起点が一覧の更新で消えていることがある (QR)。入れ子なら親のモーダルへ戻す
      fallbackFocusRef.current = dialog.parentElement?.closest<HTMLElement>("dialog") ?? null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      // 直前の cleanup でフォーカスが背面へ戻されている (StrictMode)
      dialog.focus();
    }
  }, []);

  // 焦点の復帰は unmount だけで行う (退場の間は開いたままなので、閉じる要求では戻さない)
  useEffect(() => {
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      else fallbackFocusRef.current?.focus();
    };
  }, []);

  // 実行中は native の close と開き直しの間だけ面が閉じる。その 1 拍で焦点が body へ落ち、
  // Escape が設定ページの戻る (window の keydown) へ届いて画面が切り替わるため、document で先に止める
  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy]);

  const startClosing = useCallback(() => {
    if (closedRef.current || closingRef.current) return;
    closingRef.current = true;
    // 退場中に Enter で確定させない。`inert` は次の描画から効くので、その前に焦点を外しておく
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (dialog !== null && active instanceof HTMLElement && dialog.contains(active)) active.blur();
    dialog?.setAttribute("inert", "");
    setClosing(true);
  }, []);

  /** 退場中の操作を握りつぶす。capture で受けるので、子の onClick / onSubmit まで届かせない */
  const stopWhileClosing = (event: SyntheticEvent) => {
    if (!closingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // handle は呼び出し側が意図して閉じる経路 (実行成功など) なので busy でも通す。
  // 実行中に閉じさせないのは操作 (Escape / X / キャンセル) の側で判定する
  useEffect(() => {
    handleRef.current = { requestClose: startClosing };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, startClosing]);

  const phase = useExitPhase(!closing, dialogRef);

  // 退場アニメが終わった描画で閉じる。`close()` と unmount を同じ効果に置き、
  // 閉状態の寸法が 1 フレーム出ないようにする
  useEffect(() => {
    if (!closing || phase !== "closed" || closedRef.current) return;
    closedRef.current = true;
    dialogRef.current?.close();
    onClosedRef.current();
  }, [closing, phase]);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label={label}
      aria-busy={ariaBusy}
      tabIndex={-1}
      data-closing={closing}
      // 退場中は操作も読み上げも受けない (見せているだけの面)
      inert={closing}
      // 内側の dialog (portal) の cancel / close は React のツリーを伝わる。自分の分だけを受ける
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        // 退場中も既定動作を止める (2 回目の Escape は cancelable でないので、そのときは close で合流する)
        event.preventDefault();
        if (busyRef.current) return;
        startClosing();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        if (closedRef.current) return;
        if (busyRef.current) {
          // 実行中は閉じさせない (作った / 移した結果を取りこぼさない)。2 回目の Escape は
          // 止められずに close が来るため、開き直して面を保つ
          event.currentTarget.showModal();
          return;
        }
        // 止められなかった native の close。待ち直さず完了へ合流させる
        closedRef.current = true;
        onClosedRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      // 退場中は確定・実行を受けない (inert が効くまでの同じ tick に Enter が届く)
      onClickCapture={stopWhileClosing}
      onSubmitCapture={stopWhileClosing}
      onClick={(event) => {
        if (event.target === event.currentTarget) onBackgroundClick?.();
      }}
      className={cn("modal-dialog", FRAME_CLASS[frame], className)}
    >
      {children}
    </dialog>
  );
}
