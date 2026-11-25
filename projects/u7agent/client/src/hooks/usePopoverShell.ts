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

/**
 * 寸法の上限を呼び出し側が書く。渡すと hook は既定の `max-width` / `max-height` を書かない
 * (幅を固定する・スクロールする内側にだけ高さの上限を当てる、といった面があるため)。
 */
export type PopoverSize = (input: PopoverPlaceInput & { margin: number }) => void;

/**
 * 開いた直後に焦点を当てる要素。`null` は焦点を動かさない (開いてもトリガーに残す画面)。
 * 省略したときは最初の有効な項目へ移す。
 */
export type PopoverOpenFocus = (items: readonly HTMLButtonElement[]) => HTMLElement | null;

/**
 * 画面ごとに選ぶ任意の要素。渡したものだけが有効になる (全部を 1 つの設定として扱わない)。
 * コールバックは最新のものが使われるので、呼び出し側で identity を固定しなくてよい。
 */
export interface PopoverShellOptions {
  /** scroll / resize の再配置。`cause` で「置き直す / 閉じる」を選ぶ */
  reposition?: PopoverReposition;
  /** focus が外へ出たときの終了。付ける要素は画面が選ぶ (`exitProps` / `containerProps`) */
  exitOnBlur?: PopoverExitOnBlur;
  /** 寸法の上限を書く。省略すると hook が `margin` から書く */
  size?: PopoverSize;
  /** 開いた直後の焦点。省略すると最初の有効な項目へ移す */
  openFocus?: PopoverOpenFocus;
  /**
   * トリガーの ↑↓ でも開く (native select と同じ作法)。既定は開かない: 矢印で開く画面だけが true にする
   * (⋯ ボタンなど、矢印に反応しないトリガーの操作を増やさない)
   */
  openOnArrowKeys?: boolean;
  /** 開閉の通知 (標準の close も含む)。親が開閉を持つ画面向け */
  onOpenChange?: (open: boolean) => void;
}

/** 任意の要素へ渡す動作。どちらを選ぶかは呼び出し側が決め、hook は両方を等しく扱う */
export type PopoverActions = {
  /** いまの位置へ置き直す (幅 / 高さの上限も書き直す) */
  place: () => void;
  /** 閉じる (焦点は移さない。blur させると native の復帰が起きず、トリガーへ戻れない) */
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
    /**
     * ↑↓ で開く。`openOnArrowKeys` を渡した画面だけが反応し、既に開いていれば `openFocus` の
     * 位置へ焦点を移す (渡していない画面では何もしない)
     */
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** popover へ配る配線。`ref` が toggle の購読と開閉状態の同期を持つ */
  popoverProps: {
    ref: (element: HTMLElement | null) => void;
    /**
     * ↑↓ / Home / End で項目を移り、Escape を App へ通さない。`ref` と一緒に popover へ付ける
     * (トリガーを包む要素へ付ける画面は下の `containerProps` を使う)
     */
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  /**
   * focus が外へ出たときの終了。popover へ付けるか、トリガーを包む要素へ付けるかは画面が選ぶ
   * (`exitOnBlur` を渡したときだけ効く)
   */
  exitProps: {
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  /**
   * トリガーと popover を包む要素向け。開いている間の Escape を外へ通さず、包みの外へ focus が
   * 出たら閉じる (開いた直後の焦点がトリガーに残る画面は、Escape が popover ではなくトリガーで
   * 起きるためこちらを使う)
   */
  containerProps: {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  /** 項目の ref。矢印キーの移動対象はこの並び (呼び出し側は index を渡すだけ) */
  itemRef: (index: number) => (element: HTMLButtonElement | null) => void;
  /** 開いているか (native の状態を購読した値)。自前のトリガーを持つ画面が開閉を切り替えるのに使う */
  isOpen: boolean;
  close: () => void;
  /** 項目を選んだ直後: 焦点を外してから閉じ、トリガーへ焦点を戻す (項目は選ぶと消えるため) */
  closeBySelection: () => void;
  /** 開いて配置し、`openFocus` の位置へ焦点を移す (既に開いていれば焦点だけ移す) */
  open: () => void;
};

/**
 * native popover の「殻」。開閉の正を popover の `toggle` に置き、トリガーの押下 / Escape と矢印キー /
 * 配置の書き込み / 任意の後始末を 1 か所にまとめる。位置そのものは系統ごとの純関数
 * (`lib/popoverPlacement.ts` / `lib/agentPicker.ts` / `lib/rowMenu.ts` / `lib/selectMenu.ts`) が持ち、
 * ここは「どの系統の結果を `popover.style` へ書くか」だけを知る (計算を共有すると role と寄せ方が混ざる)。
 * 任意の要素は `options` で受け、渡されたものだけが有効になる。
 * `place` は `placeNow` の依存なので、呼び出し側で identity を固定する (毎描画で変わると配置と購読を張り直す)。
 */
export function usePopoverShell(place: PopoverPlace, margin: number, options: PopoverShellOptions = {}): PopoverShell {
  const { reposition, exitOnBlur, size, openFocus, openOnArrowKeys, onOpenChange } = options;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  // 任意の callback は最新を使う。依存に入れると、呼び出し側が毎描画で新しい関数を渡すたびに
  // scroll / resize の購読を張り直すことになる (identity を固定する負担を呼び出し側へ返さない)
  const optionalRef = useRef({ reposition, exitOnBlur, size, openFocus, onOpenChange });
  optionalRef.current = { reposition, exitOnBlur, size, openFocus, onOpenChange };
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
    const trigger = triggerRef.current;
    const sizeNow = optionalRef.current.size;
    if (sizeNow === undefined) {
      // 幅 / 高さの上限を測る前に書く: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
      // (上限が無いと、項目の多いメニューが低い窓で viewport をはみ出して下部の項目へ届かない)
      popover.style.maxWidth = `${Math.max(0, viewport.width - margin * 2)}px`;
      popover.style.maxHeight = `${Math.max(0, viewport.height - margin * 2)}px`;
    } else {
      // 上限の当て先 (popover か、その中のスクロールする一覧か) は系統ごとに違う。書く側が決める
      sizeNow({ popover, trigger, viewport, margin });
    }
    const next = place({ popover, trigger, viewport });
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
    if (isOpen) placeNow();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss) もここで観測して aria-expanded へ写す。
  // Effect ではなく ref の付け外しで購読する: status の取得前は popover を描画しない画面があり、
  // 依存配列が空の Effect では、後から mount した popover を購読できない
  const onToggle = useCallback((event: Event) => {
    const next = (event as ToggleEvent).newState === "open";
    setIsOpen(next);
    // 開閉を親が持つ画面 (入力欄の下の面など) へ、標準の close も含めて同じ経路で伝える
    optionalRef.current.onOpenChange?.(next);
  }, []);
  const attachPopover = useCallback(
    (element: HTMLElement | null) => {
      const previous = popoverRef.current;
      if (previous) previous.removeEventListener("toggle", onToggle);
      popoverRef.current = element;
      if (element === null) return;
      element.addEventListener("toggle", onToggle);
      setIsOpen(element.matches(":popover-open"));
    },
    [onToggle],
  );

  // 開いている間だけ位置を取り直す。scroll は capture で受けないとツリーのスクロール枠の分を拾えない
  useEffect(() => {
    if (!isOpen || !hasReposition) return;
    const onScroll = () => optionalRef.current.reposition?.({ cause: "scroll", place: placeNow, close });
    const onResize = () => optionalRef.current.reposition?.({ cause: "resize", place: placeNow, close });
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [close, hasReposition, isOpen, placeNow]);

  /**
   * 開いた直後の焦点。`openFocus` を渡した画面はそこが決め (検索欄・選択中の行など)、
   * 渡さない画面は最初の有効な項目へ入る
   */
  const focusTarget = useCallback(() => {
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    const focus = optionalRef.current.openFocus;
    if (focus === undefined) {
      items[0]?.focus();
      return;
    }
    focus(items)?.focus();
  }, []);

  /** 開いて配置し、焦点を `openFocus` の位置へ移す。開いているときは焦点だけ移す (二重の showPopover を避ける) */
  const open = useCallback(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    if (!popover.matches(":popover-open")) {
      popover.showPopover();
      placeNow();
    }
    focusTarget();
  }, [focusTarget, placeNow]);

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
      focusTarget();
    },
    [focusTarget, placeNow],
  );

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
      event.stopPropagation();
      return;
    }
    const direction =
      event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowUp"
          ? "previous"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    // Enter / Space は native の button に任せる。要素自身が処理したキー (検索欄の ↑↓ など) と、
    // 矢印で候補を選ぶ native の select は横取りしない
    if (direction === null || event.defaultPrevented) return;
    if (event.target instanceof HTMLSelectElement) return;
    // 既定動作 (popover の外のスクロール) を止める。項目が 0 件でも止める (空の一覧で動かさない)
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextRowMenuIndex(current, items.length, direction)]?.focus();
  }, []);

  /**
   * トリガーの ↑↓ で開く (`openOnArrowKeys: true` の画面だけ)。押したときと同じ経路 (click) を通すので、
   * 開く前に取得や絞り込みの初期化がある画面も同じ手順になる。既定で開かないのは、矢印に
   * 反応しないトリガーの操作を増やさないため
   */
  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      // 矢印で開かない画面では触らない (base どおり既定動作 = ページのスクロールに任せる)
      if (!openOnArrowKeys) return;
      // 既定動作 (ページのスクロール) を止める
      event.preventDefault();
      // 開いている間の矢印では何もしない。click へ渡すと toggle が閉じてしまい、開いたままの一覧が
      // 矢印で消える (焦点がトリガーへ戻れる包み型の画面で到達する)
      if (popoverRef.current?.matches(":popover-open")) return;
      triggerRef.current?.click();
    },
    [openOnArrowKeys],
  );

  /**
   * 開いている間だけ、トリガーを包む要素で Escape を止める (閉じている間は素通しにする)。
   * 開いた直後の焦点がトリガーに残る画面は、Escape が popover ではなくトリガーで起きるためこちらを使う
   */
  const onContainerKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    if (!popoverRef.current?.matches(":popover-open")) return;
    event.stopPropagation();
  }, []);

  const onBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const exit = optionalRef.current.exitOnBlur;
      if (exit === undefined) return;
      const next = event.relatedTarget;
      // 付けた要素 (popover か、トリガーを包む要素) の内側への移動は閉じる操作ではない
      if (next instanceof Node && event.currentTarget.contains(next)) return;
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
      "aria-expanded": isOpen,
      onClick: toggle,
      onKeyDown: onTriggerKeyDown,
      onPointerDown: pressTrigger,
      onPointerUp: releaseTrigger,
      onPointerCancel: releaseTrigger,
    },
    popoverProps: { ref: attachPopover, onKeyDown },
    exitProps: { onBlur },
    containerProps: { onKeyDown: onContainerKeyDown, onBlur },
    itemRef,
    isOpen,
    close,
    closeBySelection,
    open,
  };
}
