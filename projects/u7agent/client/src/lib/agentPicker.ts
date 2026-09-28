/**
 * コンポーザーのエージェント選択（自前 listbox）の共通部。位置とキーボード移動の計算だけを持つ
 * 純関数を集める（描画と popover の操作は `client/src/components/composer/AgentPicker.tsx`）。
 * ⋯ メニュー（`rowMenu.ts`）とは共有しない: あちらは `role="menu"` の右端そろえ、こちらは
 * `role="listbox"` の左端そろえで、値もテストも別に固定する。
 */

/** リストの入れ物と欄の間隔 / viewport の端からの余白 (px) */
export const AGENT_PICKER_GAP = 4;
export const AGENT_PICKER_MARGIN = 8;

export type AgentPickerRect = Pick<DOMRect, "top" | "left" | "right" | "bottom">;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * リストの `fixed` 座標。既定は欄の左下（左端をそろえる）に置き、下に入らなければ上へ倒して
 * viewport の内側へ clamp する（リストが viewport より大きい場合は上 / 左に寄せる）。
 * `list` は `max-width` を当てた後の rect を渡す（幅で折り返しが変わり高さが動くため）。
 */
export function agentPickerPlacement(
  anchor: AgentPickerRect,
  list: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = clamp(anchor.left, AGENT_PICKER_MARGIN, viewport.width - list.width - AGENT_PICKER_MARGIN);

  const below = anchor.bottom + AGENT_PICKER_GAP;
  const above = anchor.top - AGENT_PICKER_GAP - list.height;
  const top =
    below + list.height > viewport.height - AGENT_PICKER_MARGIN && above >= AGENT_PICKER_MARGIN ? above : below;
  return { left, top: clamp(top, AGENT_PICKER_MARGIN, viewport.height - list.height - AGENT_PICKER_MARGIN) };
}

/** ↑↓ / Home / End の移動先。端では止まる（循環しない）。`index` が -1（フォーカスが項目の外）のときは端の項目へ入る */
export function nextAgentOptionIndex(
  index: number,
  length: number,
  direction: "next" | "previous" | "first" | "last",
): number {
  if (length <= 0) return -1;
  if (direction === "first") return 0;
  if (direction === "last") return length - 1;
  if (index < 0) return direction === "next" ? 0 : length - 1;
  return direction === "next" ? Math.min(index + 1, length - 1) : Math.max(index - 1, 0);
}
