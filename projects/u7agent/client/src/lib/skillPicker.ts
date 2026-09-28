/**
 * チャットのスキルポップアップの共通部。幅・高さの上限と `fixed` 座標の計算だけを持つ純関数を集める
 * (描画と popover の操作は `client/src/components/composer/SkillPicker.tsx`)。
 * ⋯ メニュー (`rowMenu.ts`) / エージェント選択 (`agentPicker.ts`) とは共有しない: あちらは項目が 1 行で
 * 高さの上限を持たないが、こちらは説明を持つ行を並べるため **幅と高さの上限** が要る。
 */

/** ポップアップと欄の間隔 / viewport の端からの余白 / 幅の上限 (px) */
export const SKILL_PICKER_GAP = 4;
export const SKILL_PICKER_MARGIN = 8;
export const SKILL_PICKER_WIDTH = 340;
/** 高さの上限。compact は入力欄とメッセージを覆いすぎないよう低く抑える */
export const SKILL_PICKER_MAX_HEIGHT = 420;
export const SKILL_PICKER_MAX_HEIGHT_COMPACT = 320;
/** viewport の高さに対する上限の比。端末の高さが小さいときはこちらが効く */
export const SKILL_PICKER_HEIGHT_RATIO = 0.6;
export const SKILL_PICKER_HEIGHT_RATIO_COMPACT = 0.48;
/** 上に開くか下に開くかの分かれ目 (px)。狭くても上に開けるなら上を選ぶ */
const SKILL_PICKER_MIN_ABOVE = 160;

export type SkillPickerRect = Pick<DOMRect, "top" | "bottom">;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** ポップアップの幅。viewport が狭いときは余白を残して縮める */
export function skillPickerWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(SKILL_PICKER_WIDTH, viewportWidth - SKILL_PICKER_MARGIN * 2));
}

/**
 * 開く向きと高さの上限。コンポーザーは画面の下端にあるため上に開くのが既定で、上に入らなければ
 * 下へ倒す。上限は「設定した上限」「viewport の比」「そちら側の空き」の最小にする (そちら側で
 * スクロールさせ、viewport の外へはみ出させない)。
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
  const availableAbove = anchor.top - SKILL_PICKER_GAP - SKILL_PICKER_MARGIN;
  const availableBelow = viewport.height - anchor.bottom - SKILL_PICKER_GAP - SKILL_PICKER_MARGIN;
  // 上を優先し、そちらが狭いときだけ下へ倒す (どちらも狭ければ広い方になる)
  const above = availableAbove >= Math.min(availableBelow, SKILL_PICKER_MIN_ABOVE);
  const available = Math.max(0, above ? availableAbove : availableBelow);
  return { above, maxHeight: Math.min(cap, available) };
}

/** ポップアップの左端。欄の左端にそろえ、右端で収まらなければ左へ寄せて viewport の内側へ clamp する */
export function skillPickerLeft(anchor: Pick<DOMRect, "left">, width: number, viewportWidth: number): number {
  return clamp(anchor.left, SKILL_PICKER_MARGIN, viewportWidth - width - SKILL_PICKER_MARGIN);
}

/** ポップアップの上端。`height` は高さの上限を当てた後に測った実際の高さ */
export function skillPickerTop(
  anchor: SkillPickerRect,
  height: number,
  above: boolean,
  viewportHeight: number,
): number {
  const top = above ? anchor.top - SKILL_PICKER_GAP - height : anchor.bottom + SKILL_PICKER_GAP;
  return clamp(top, SKILL_PICKER_MARGIN, Math.max(SKILL_PICKER_MARGIN, viewportHeight - height - SKILL_PICKER_MARGIN));
}
