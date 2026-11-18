import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { nextRowMenuIndex } from "../lib/rowMenu";

/** `documentElement` の client 寸法。位置を書く前に測る 1 回だけの viewport */
export type PopoverViewport = { width: number; height: number };

export type PopoverPlaceInput = {
  /** 書き込む先の native popover */
  popover: HTMLElement;
  /** 開いたトリガー。系統ごとの純関数へ渡す rect はここから読む (別の要素を見る画面は自前の ref を使う) */
  trigger: HTMLElement | null;
  viewport: PopoverViewport;
};

/**
 * 系統ごとの配置計算。返した `left` / `top` を hook が `popover.style` へ書き、`null` なら閉じる
 * (アンカーが clip の外へ出た等)。
 */
export type PopoverPlace = (input: PopoverPlaceInput) => { left: number; top: number } | null;

/** 任意の要素へ渡す動作。どちらを選ぶかは呼び出し側が決め、hook は両方を等しく扱う */
export type PopoverActions = {
  /** いまの位置へ置き直す (幅 / 高さの上限も書き直す) */
  place: () => void;
  /** 閉じる (焦点は移さない) */
  close: () => void;
};

/** scroll / resize の再配置。`cause` で「置き直す / 閉じる」を選ぶ */
export type PopoverReposition = (input: { cause: "scroll" | "resize" } & PopoverActions) => void;

/** focus が popover の外へ出たときの終了。閉じるかどうかは呼び出し側が決める */
export type PopoverExitOnBlur = (actions: PopoverActions) => void;

export type PopoverShell = {
  /** トリガーへ配る配線。`aria-expanded` をここが持つので、開閉の写し忘れが起きない */
  triggerProps: {
    ref: RefObject<HTMLButtonElement | null>;
    "aria-expanded": boolean;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** popover へ配る配線。`ref` が toggle の購読と開閉状態の同期を持つ */
  popoverProps: {
    ref: (element: HTMLElement | null) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  /** 項目の ref。矢印キーの移動対象はこの並び (呼び出し側は index を渡すだけ) */
  itemRef: (index: number) => (element: HTMLButtonElement | null) => void;
  close: () => void;
  /** 項目を選んだ直後: 焦点を外してから閉じ、トリガーへ焦点を戻す (項目は選ぶと消えるため) */
  closeBySelection: () => void;
};

/**
 * native popover の「殻」。開閉の正を popover の `toggle` に置き、トリガーの押下 / Escape と矢印キー /
 * 配置の書き込み / 任意の後始末を 1 か所にまとめる。位置そのものは系統ごとの純関数
 * (`lib/popoverPlacement.ts` / `lib/agentPicker.ts` / `lib/rowMenu.ts` / `lib/selectMenu.ts`) が持ち、
 * ここは「どの系統の結果を `popover.style` へ書くか」だけを知る (計算を共有すると role と寄せ方が混ざる)。
 * 任意の要素は個別の引数で受け、渡されたものだけが有効になる (設定束やフラグは持たない)。
 * `place` は `placeNow` の依存なので、呼び出し側で identity を固定する (毎描画で変わると配置と購読を張り直す)。
 */
export function usePopoverShell(
  place: PopoverPlace,
  margin: number,
  reposition?: PopoverReposition,
  exitOnBlur?: PopoverExitOnBlur,
): PopoverShell {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  // 任意の callback は最新を使う。依存に入れると、呼び出し側が毎描画で新しい関数を渡すたびに
  // scroll / resize の購読を張り直すことになる (identity を固定する負担を呼び出し側へ返さない)
  const optionalRef = useRef({ reposition, exitOnBlur });
  optionalRef.current = { reposition, exitOnBlur };
  const hasReposition = reposition !== undefined;
  // トリガーの mousedown は click より先にフォーカスを奪う。その focusout で閉じると直後の click が
  // 開き直してトグルが効かないため、トリガーを押している間だけ focusout での終了を保留する
  const pressingTriggerRef = useRef(false);

  const placeNow = useCallback(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const viewport = {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
    // 幅 / 高さの上限を測る前に書く: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
    // (上限が無いと、項目の多いメニューが低い窓で viewport をはみ出して下部の項目へ届かない)
    popover.style.maxWidth = `${Math.max(0, viewport.width - margin * 2)}px`;
    popover.style.maxHeight = `${Math.max(0, viewport.height - margin * 2)}px`;
    const next = place({ popover, trigger: triggerRef.current, viewport });
    if (next === null) {
      popover.hidePopover();
      return;
    }
    popover.style.left = `${next.left}px`;
    popover.style.top = `${next.top}px`;
  }, [margin, place]);

  const close = useCallback(() => {
    popoverRef.current?.hidePopover();
  }, []);

  const closeBySelection = useCallback(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && popover.contains(active)) active.blur();
    popover.hidePopover();
    // 選択後はトリガーへ焦点を戻す: 項目は消えるので、この後の確認ダイアログが「開いたボタン」を
    // 控えて閉じたときに戻せるのはここだけになる
    triggerRef.current?.focus();
  }, []);

  // 開いている間は commit のたびに置き直す。window の resize ハンドラは React の再レンダー
  // (サイドバーの docked ⇄ overlay など) より先に走り、動く前の rect を読んでしまう。commit 後なら
  // DOM は更新済みなので、ここで読む rect が新しい配置を指す
  useLayoutEffect(() => {
    if (open) placeNow();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss) もここで観測して aria-expanded へ写す。
  // Effect ではなく ref の付け外しで購読する: status の取得前は popover を描画しない画面があり、
  // 依存配列が空の Effect では、後から mount した popover を購読できない
  const onToggle = useCallback((event: Event) => {
    setOpen((event as ToggleEvent).newState === "open");
  }, []);
  const attachPopover = useCallback(
    (element: HTMLElement | null) => {
      const previous = popoverRef.current;
      if (previous) previous.removeEventListener("toggle", onToggle);
      popoverRef.current = element;
      if (element === null) return;
      element.addEventListener("toggle", onToggle);
      setOpen(element.matches(":popover-open"));
    },
    [onToggle],
  );

  // 開いている間だけ位置を取り直す。scroll は capture で受けないとツリーのスクロール枠の分を拾えない
  useEffect(() => {
    if (!open || !hasReposition) return;
    const onScroll = () => optionalRef.current.reposition?.({ cause: "scroll", place: placeNow, close });
    const onResize = () => optionalRef.current.reposition?.({ cause: "resize", place: placeNow, close });
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [close, hasReposition, open, placeNow]);

  const toggle = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const popover = popoverRef.current;
      if (popover === null) return;
      pressingTriggerRef.current = false;
      // popoverTarget はトリガー自身の押下を light dismiss の対象外にするためだけに付ける。既定の
      // activation behavior は同じトグルを二重に走らせるので止め、開閉を showPopover / hidePopover に寄せる
      event.preventDefault();
      if (popover.matches(":popover-open")) {
        popover.hidePopover();
        return;
      }
      popover.showPopover();
      placeNow();
      itemsRef.current.find((item) => item !== null && !item.disabled)?.focus();
    },
    [placeNow],
  );

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
      event.stopPropagation();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // 既定動作 (popover の外のスクロール) を止める
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextRowMenuIndex(current, items.length, event.key === "ArrowDown" ? "next" : "previous")]?.focus();
  }, []);

  const onBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const exit = optionalRef.current.exitOnBlur;
      if (exit === undefined) return;
      const next = event.relatedTarget;
      if (next instanceof Node && popoverRef.current?.contains(next)) return;
      if (next === triggerRef.current && pressingTriggerRef.current) {
        // トリガーへの押下で移るフォーカスは閉じる操作ではない (閉じるかどうかは click 側が決める)
        pressingTriggerRef.current = false;
        return;
      }
      exit({ place: placeNow, close });
    },
    [close, placeNow],
  );

  const itemRef = useCallback((index: number) => {
    return (element: HTMLButtonElement | null) => {
      itemsRef.current[index] = element;
    };
  }, []);

  const pressTrigger = useCallback(() => {
    pressingTriggerRef.current = true;
  }, []);
  const releaseTrigger = useCallback(() => {
    pressingTriggerRef.current = false;
  }, []);

  return {
    triggerProps: {
      ref: triggerRef,
      "aria-expanded": open,
      onClick: toggle,
      onPointerDown: pressTrigger,
      onPointerUp: releaseTrigger,
      onPointerCancel: releaseTrigger,
    },
    popoverProps: { ref: attachPopover, onKeyDown, onBlur },
    itemRef,
    close,
    closeBySelection,
  };
}
