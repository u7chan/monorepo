// ConfirmPopover - 破壊的操作の確認を、対象ボタンの脇に出す小さなポップオーバー

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const PANEL_WIDTH = 272;
const GAP = 10;
const VIEWPORT_EDGE = 12;

interface ConfirmPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

interface PanelPosition {
  top: number;
  left: number;
  caretLeft: number;
  side: "bottom" | "top";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 確認ポップオーバー。
 * 位置は anchor を基準に実測して決める (カード幅やスクロール位置に依存させない)。
 * 画面下に入りきらないときだけ上に反転し、横向きはビューポート内に寄せる。
 */
export function ConfirmPopover({
  open,
  anchorRef,
  title,
  description,
  confirmLabel,
  pending = false,
  onConfirm,
  onClose,
}: ConfirmPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // 開いている間だけ、外側クリック / Esc / スクロールで閉じる。
  // スクロールで閉じるのは、absolute 配置のままだとカードと一緒に動いて
  // 反転判定が古くなるため。位置を追従させるより閉じるほうが予測しやすい。
  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      // 2 つのボタンだけのダイアログなので、Tab は中で循環させる。
      // フォーカスだけ外に抜けると、開いたままの確認が背後の操作を誘うため。
      if (event.key !== "Tab") {
        return;
      }

      const buttons = panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!buttons || buttons.length === 0) {
        return;
      }

      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) {
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleScroll = () => onClose();

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open, onClose, anchorRef]);

  // 開いた時点でフォーカスしていた要素を覚え、閉じたらそこへ返す
  useEffect(() => {
    if (!open) {
      return;
    }

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    return () => {
      const restoreTarget = restoreFocusRef.current ?? anchorRef.current;
      restoreTarget?.focus();
    };
  }, [open, anchorRef]);

  // パネルは位置が決まるまで visibility: hidden なので、その間の focus() は無視される。
  // position が入って可視になった後にフォーカスを移す (先に移すと role=dialog が
  // 読み上げられず、Shift+Tab で外へ抜ける)。
  useEffect(() => {
    if (!open || !position) {
      return;
    }

    cancelRef.current?.focus();
  }, [open, position]);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) {
      return;
    }

    // 位置の基準は、ラッパー (position: relative) の offsetParent
    const origin = panel.offsetParent instanceof HTMLElement ? panel.offsetParent : null;
    if (!origin) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const originRect = origin.getBoundingClientRect();
    const panelHeight = panel.offsetHeight;

    const spaceBelow = window.innerHeight - anchorRect.bottom - GAP - VIEWPORT_EDGE;
    const flipAbove =
      spaceBelow < panelHeight && anchorRect.top - GAP - VIEWPORT_EDGE > panelHeight;

    const side: PanelPosition["side"] = flipAbove ? "top" : "bottom";
    const top = flipAbove
      ? anchorRect.top - originRect.top - GAP - panelHeight
      : anchorRect.bottom - originRect.top + GAP;

    const preferredLeft = anchorRect.right - originRect.left - PANEL_WIDTH;
    const left = clamp(
      preferredLeft,
      VIEWPORT_EDGE - originRect.left,
      window.innerWidth - VIEWPORT_EDGE - PANEL_WIDTH - originRect.left,
    );

    const caretLeft = clamp(
      anchorRect.left + anchorRect.width / 2 - originRect.left - left - 6,
      14,
      PANEL_WIDTH - 26,
    );

    setPosition({ top, left, caretLeft, side });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
  }, [open, measure]);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width: PANEL_WIDTH,
        visibility: position ? "visible" : "hidden",
      }}
      className="absolute z-50 rounded-xl border border-line-strong bg-ink-800 p-3.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)]"
    >
      {/* 吹き出しの三角。anchor の中心を指して、どのボタンの確認かを見失わせない */}
      {position && (
        <span
          aria-hidden="true"
          style={{ left: position.caretLeft }}
          className={[
            "absolute size-2.5 rotate-45 border-line-strong bg-ink-800",
            position.side === "bottom"
              ? "-top-[5px] border-t border-l"
              : "-bottom-[5px] border-r border-b",
          ].join(" ")}
        />
      )}

      <p id={titleId} className="text-[13px] font-semibold text-fg">
        {title}
      </p>
      <p id={descriptionId} className="mt-1 text-[12px] leading-relaxed text-fg-2">
        {description}
      </p>

      <div className="mt-3 flex items-center justify-end gap-1.5">
        <button
          ref={cancelRef}
          type="button"
          onClick={onClose}
          className="h-8 rounded-md px-2.5 text-[12px] font-medium text-fg-2 transition-colors hover:bg-ink-700 hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="h-8 rounded-md bg-dead px-3 text-[12px] font-semibold text-ink-950 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

export default ConfirmPopover;
