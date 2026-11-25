import { useCallback, useRef, type KeyboardEvent, type RefObject } from "react";
import { popoverLeft, popoverTop } from "../lib/popoverPlacement";
import { selectMenuArrowIndex, selectMenuPlacement, selectMenuWidth } from "../lib/selectMenu";
import type { PopoverPlace, PopoverPlaceInput, PopoverSize } from "./usePopoverShell";

/**
 * 一覧と一覧の外に置く行 (検索欄・見出し・注記) の境目。一覧の高さの上限からこの分を引く。
 * 何が外にあるかは画面ごとに違うので、測り方だけを呼び出し側が渡す。
 */
export type SelectMenuChrome = (input: { popover: HTMLElement; list: HTMLElement }) => number;

export type SearchableSelectMenu = {
  listRef: RefObject<HTMLDivElement | null>;
  size: PopoverSize;
  place: PopoverPlace;
  /** 検索欄のキー。Enter は外側の form を送信させず、↑↓ は一覧へ抜ける */
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * 検索つきの自前 select が共有する popover の寸法・配置と、検索欄のキー操作。位置は `lib/selectMenu.ts`
 * の系統をそのまま使う (選択肢の読み上げ名や行の作りは画面が持ち、ここは一覧の外枠だけを見る)。
 */
export function useSearchableSelectMenu({
  value,
  values,
  chrome,
}: {
  /** 選択中の値。↓ で入る行を決める */
  value: string;
  /** いま表示している行の値 (絞り込み後) */
  values: readonly string[];
  chrome: SelectMenuChrome;
}): SearchableSelectMenu {
  const listRef = useRef<HTMLDivElement | null>(null);
  // 寸法の計算は配置と同じく identity を固定する (毎描画で変わると購読を張り直す)。測る対象は
  // ref で読むので、呼び出し側はコールバックの identity を固定しなくてよい
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  // 幅と高さの上限を先に確定させる: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
  const size = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    popover.style.width = `${selectMenuWidth(anchor.width, viewport.width)}px`;
    const list = listRef.current;
    if (list === null) return;
    const { maxHeight } = selectMenuPlacement(anchor, viewport.height);
    list.style.maxHeight = `${Math.max(0, maxHeight - chromeRef.current({ popover, list }))}px`;
  }, []);

  const place = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    const anchor = trigger.getBoundingClientRect();
    const width = selectMenuWidth(anchor.width, viewport.width);
    const { above } = selectMenuPlacement(anchor, viewport.height);
    return {
      left: popoverLeft(anchor, width, viewport.width),
      top: popoverTop(anchor, popover.getBoundingClientRect().height, above, viewport.height),
    };
  }, []);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      // 停止しないと外側の form (キーの保存・登録) が送信される
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>("button[role='option']") ?? [];
    items[selectMenuArrowIndex(event.key, value, values, items.length)]?.focus();
  };

  return { listRef, size, place, onSearchKeyDown };
}
