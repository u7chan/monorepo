/**
 * コンポーザーのエージェント選択と既定モデルのピッカー（自前 listbox）の共通部。位置と寸法の上限を
 * 持つ純関数を集める（描画は `client/src/components/composer/AgentPicker.tsx` /
 * `client/src/components/model-settings/ModelDefaultPicker.tsx`、寸法の書き込みは
 * `client/src/hooks/useAgentPickerPopover.ts`）。
 * ⋯ メニュー（`rowMenu.ts`）とは共有しない: あちらは `role="menu"` の右端そろえ、こちらは
 * `role="listbox"` の左端そろえで、値もテストも別に固定する。
 */

/** リストの入れ物と欄の間隔 / viewport の端からの余白 (px) */
export const AGENT_PICKER_GAP = 4;
export const AGENT_PICKER_MARGIN = 8;
/**
 * 一覧の高さの既定の上限 (px)。`max-h-64` 相当で、低い viewport ではここから viewport の残りへ縮める
 * (ソフトキーボードが出ている間も一覧が欄と一緒に見えるようにする)。
 */
export const AGENT_PICKER_LIST_MAX_HEIGHT = 256;

export type AgentPickerRect = Pick<DOMRect, "top" | "left" | "right" | "bottom">;

/** 一覧の幅の上限 (px)。viewport の端から左右の余白を引く */
export function agentPickerMaxWidth(viewportWidth: number, margin: number): number {
  return Math.max(0, viewportWidth - margin * 2);
}

/**
 * 一覧の高さの上限 (px)。既定の上限と、viewport から余白と一覧以外の高さを引いた残りの小さい方。
 * 低い viewport (ソフトキーボード表示中を含む) ではここで縮める。
 */
export function agentPickerListMaxHeight(viewportHeight: number, margin: number, chrome: number): number {
  const available = viewportHeight - margin * 2 - chrome;
  return Math.max(0, Math.min(AGENT_PICKER_LIST_MAX_HEIGHT, available));
}

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
