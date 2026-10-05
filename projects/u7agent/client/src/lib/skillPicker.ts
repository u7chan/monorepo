/**
 * チャットのスキルポップアップの共通部。幅・高さの上限だけを持ち、位置の計算は native popover 共通の
 * `client/src/lib/popoverPlacement.ts` に任せる (描画と popover の操作は
 * `client/src/components/composer/SkillPicker.tsx`)。Model / Effort のポップアップも同じ位置計算を使う。
 */

import {
  popoverAvailableHeight,
  popoverLeft,
  popoverOpensAbove,
  popoverTop,
  popoverWidth,
  type PopoverAnchor,
} from "./popoverPlacement";

/** 幅の上限 (px)。説明を持つ行を並べるため、⋯ メニュー / エージェント選択より広く取る */
export const SKILL_PICKER_WIDTH = 340;
/** 高さの上限。compact は入力欄とメッセージを覆いすぎないよう低く抑える */
export const SKILL_PICKER_MAX_HEIGHT = 420;
export const SKILL_PICKER_MAX_HEIGHT_COMPACT = 320;
/** viewport の高さに対する上限の比。端末の高さが小さいときはこちらが効く */
export const SKILL_PICKER_HEIGHT_RATIO = 0.6;
export const SKILL_PICKER_HEIGHT_RATIO_COMPACT = 0.48;

export type SkillPickerRect = PopoverAnchor;

/** ポップアップの幅。viewport が狭いときは余白を残して縮める */
export function skillPickerWidth(viewportWidth: number): number {
  return popoverWidth(SKILL_PICKER_WIDTH, viewportWidth);
}

/**
 * 開く向きと高さの上限。上に開くのが既定で、上に入らなければ下へ倒す。上限は「設定した上限」
 * 「viewport の比」「そちら側の空き」の最小にする (そちら側でスクロールさせ、viewport の外へは
 * み出させない)。
 */
export function skillPickerLayout(
  anchor: SkillPickerRect,
  viewport: { width: number; height: number },
  compact: boolean,
): { above: boolean; maxHeight: number } {
  const cap = Math.min(
    compact ? SKILL_PICKER_MAX_HEIGHT_COMPACT : SKILL_PICKER_MAX_HEIGHT,
    viewport.height * (compact ? SKILL_PICKER_HEIGHT_RATIO_COMPACT : SKILL_PICKER_HEIGHT_RATIO),
  );
  const above = popoverOpensAbove(anchor, viewport.height);
  return { above, maxHeight: Math.min(cap, popoverAvailableHeight(anchor, viewport.height, above)) };
}

/** ポップアップの左端 (共有計算の別名)。スキル一覧は説明を持つ幅広の面なので、上限だけが固有 */
export const skillPickerLeft = popoverLeft;
/** ポップアップの上端 (共有計算の別名)。`height` は高さの上限を当てた後に測った実際の高さ */
export const skillPickerTop = popoverTop;
