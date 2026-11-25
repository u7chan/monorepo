import { useCallback, useRef, type RefObject } from "react";
import { agentPickerListMaxHeight, agentPickerMaxWidth, agentPickerPlacement } from "../lib/agentPicker";
import type { PopoverPlace, PopoverPlaceInput, PopoverSize } from "./usePopoverShell";

export type AgentPickerPopover = {
  listRef: RefObject<HTMLDivElement | null>;
  size: PopoverSize;
  place: PopoverPlace;
};

/**
 * エージェント / 既定モデルのピッカーが共有する popover の寸法・配置。位置は `lib/agentPicker.ts` の
 * 系統をそのまま使い、幅は欄に合わせ、高さの上限はスクロールする一覧に当てる。
 */
export function useAgentPickerPopover(): AgentPickerPopover {
  const listRef = useRef<HTMLDivElement | null>(null);

  // 幅を先に確定させる: max-width で折り返しと内部スクロールが決まり、rect が最終の大きさになる。
  // 一覧以外の高さは popover と一覧の rect の差で測る
  const size = useCallback(({ popover, trigger, viewport, margin }: PopoverPlaceInput & { margin: number }) => {
    if (trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    popover.style.minWidth = `${anchor.width}px`;
    popover.style.maxWidth = `${agentPickerMaxWidth(viewport.width, margin)}px`;
    const list = listRef.current;
    if (list === null) return;
    const chrome = popover.getBoundingClientRect().height - list.getBoundingClientRect().height;
    list.style.maxHeight = `${agentPickerListMaxHeight(viewport.height, margin, chrome)}px`;
  }, []);

  const place = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    return agentPickerPlacement(trigger.getBoundingClientRect(), popover.getBoundingClientRect(), viewport);
  }, []);

  return { listRef, size, place };
}
