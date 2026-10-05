/**
 * native popover の位置決めの共通部。幅・高さの上限と `fixed` 座標の計算だけを持つ純関数を集める
 * (描画と popover の操作は各コンポーネント)。チャットの composer では入力欄が画面の下端にあり、
 * ポップアップは「トリガーの上を優先し、入らなければ下へ倒し、viewport の内側へ clamp する」形で
 * そろう。スキル一覧 (`client/src/lib/skillPicker.ts`) と Model / Effort
 * (`client/src/components/composer/ModelEffortControls.tsx`) がこの計算を共有する。
 * ⋯ メニュー (`rowMenu.ts`) / エージェント選択 (`agentPicker.ts`) は共有しない: あちらは項目が 1 行で
 * 幅も内容に追随させるため、上へ倒す判定と clamp だけでは足りない (docs/ui-layout.md)。
 */

/** ポップアップと欄の間隔 / viewport の端からの余白 (px) */
export const POPOVER_GAP = 4;
export const POPOVER_MARGIN = 8;
/** 上に開くか下に開くかの分かれ目 (px)。狭くても上に開けるなら上を選ぶ */
export const POPOVER_MIN_ABOVE = 160;

export type PopoverAnchor = Pick<DOMRect, "top" | "bottom">;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** ポップアップの幅。viewport が狭いときは左右の余白を残して縮める */
export function popoverWidth(max: number, viewportWidth: number): number {
  return Math.max(0, Math.min(max, viewportWidth - POPOVER_MARGIN * 2));
}

/**
 * 開く向き。上を優先し、そちらが狭いときだけ下へ倒す (どちらも分かれ目に満たなければ広い方になる)。
 * 下端の入力欄から開くのが既定なので、上に入らないときだけ下向きにする。
 */
export function popoverOpensAbove(anchor: PopoverAnchor, viewportHeight: number): boolean {
  const availableAbove = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  const availableBelow = viewportHeight - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  return availableAbove >= Math.min(availableBelow, POPOVER_MIN_ABOVE);
}

/**
 * 選んだ向きの空き (px)。高さの上限をここに合わせて縮める (そちら側で内部スクロールさせ、
 * viewport の外へはみ出させない)。空きが無くても負にしない。
 */
export function popoverAvailableHeight(anchor: PopoverAnchor, viewportHeight: number, above: boolean): number {
  const available = above
    ? anchor.top - POPOVER_GAP - POPOVER_MARGIN
    : viewportHeight - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  return Math.max(0, available);
}

/** ポップアップの左端。欄の左端にそろえ、右端で収まらなければ左へ寄せて viewport の内側へ clamp する */
export function popoverLeft(anchor: Pick<DOMRect, "left">, width: number, viewportWidth: number): number {
  return clamp(anchor.left, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN));
}

/** ポップアップの上端。`height` は高さの上限を当てた後に測った実際の高さ */
export function popoverTop(anchor: PopoverAnchor, height: number, above: boolean, viewportHeight: number): number {
  const top = above ? anchor.top - POPOVER_GAP - height : anchor.bottom + POPOVER_GAP;
  return clamp(top, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportHeight - height - POPOVER_MARGIN));
}
