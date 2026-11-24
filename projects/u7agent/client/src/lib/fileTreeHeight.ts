/**
 * ファイルツリー (FileBrowser) の高さの規則。**上下 2 段のときだけ**効く (左右 2 段では高さは容器に従う)。
 * 幅 (fileTreeWidth.ts) と形は同じで、既定が「内容の高さ」で px を持たない点と、0px (ツリーを完全に
 * 隠す) を選べる点が違う。保存は localStorage の 1 キーに閉じ、保存先の解決と状態の控えは
 * deviceSettingsStore.ts (docs/ui-layout.md)。
 */

import { createDeviceSettingsStore, type DeviceSettingsStorage, type DeviceSettingsStore } from "./deviceSettingsStore";

/** 未指定のときの上限 = 従来の `max-h-64` */
export const FILE_TREE_HEIGHT_DEFAULT_MAX = 256;
/** 選べる下限。0px はツリーを完全に隠す (境界のハンドルは残るので戻せる) */
export const FILE_TREE_HEIGHT_MIN = 0;
/** プレビューへ残す最低高さ */
export const FILE_TREE_PREVIEW_MIN_HEIGHT = 240;
/** キーボード操作 (↑↓) の 1 歩 */
export const FILE_TREE_HEIGHT_STEP = 16;
/** これより大きい保存値は壊れた値として捨てる */
export const FILE_TREE_HEIGHT_STORE_LIMIT = 2000;
/** 保存キー。テーマ等と同じく端末ローカルの表示設定として持つ */
export const FILE_TREE_HEIGHT_KEY = "u7agent-file-tree-height";

export type FileTreeHeightBounds = {
  min: number;
  max: number;
};

/**
 * 高さの下限 / 上限。`containerHeight` は本文の `@container` の `clientHeight` (整数) で、
 * 未計測 (0 以下) は null を返す (上限が容器に依存するため、推測しない)。
 * 上限は `max(min, 容器 − プレビュー下限)` なので、容器がプレビュー下限以下では min == max になり
 * ハンドルごと出さない (canResizeFileTreeHeight)。
 */
export function fileTreeHeightBounds(containerHeight: number): FileTreeHeightBounds | null {
  const container = Math.round(containerHeight);
  if (container <= 0) return null;
  const min = FILE_TREE_HEIGHT_MIN;
  const max = Math.max(min, container - FILE_TREE_PREVIEW_MIN_HEIGHT);
  return { min, max };
}

/** 高さを選べるか。min == max (容器がプレビュー下限以下) ではハンドルを出さない */
export function canResizeFileTreeHeight(bounds: FileTreeHeightBounds | null): boolean {
  return bounds !== null && bounds.max > bounds.min;
}

/** 選べる高さへ丸める。state は clamp 前を持つため、表示のたびにここを通す */
export function clampFileTreeHeight(height: number, bounds: FileTreeHeightBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(height)));
}

/**
 * 表示高さ。未指定 (null) は「内容の高さ (上限 256px)」に任せるため null のまま返す
 * (CSS 側が `height: auto` と上限で解決する)。未計測では上限が決まらないため clamp しない。
 */
export function fileTreeHeight(requested: number | null, containerHeight: number): number | null {
  if (requested === null) return null;
  const bounds = fileTreeHeightBounds(containerHeight);
  return bounds === null ? requested : clampFileTreeHeight(requested, bounds);
}

/**
 * CSS 変数 `--file-tree-height-max` に入れる「未指定のときの上限」。未計測では既定の上限
 * (推測せず、計測後に容器ぶんまで詰める)。
 */
export function fileTreeHeightLimit(containerHeight: number): number {
  const bounds = fileTreeHeightBounds(containerHeight);
  return bounds === null ? FILE_TREE_HEIGHT_DEFAULT_MAX : Math.min(FILE_TREE_HEIGHT_DEFAULT_MAX, bounds.max);
}

/** キーボード操作の 1 歩。端では clamp で止まる */
export function stepFileTreeHeight(height: number, delta: number, bounds: FileTreeHeightBounds): number {
  return clampFileTreeHeight(height + delta, bounds);
}

/** 保存値を読む。0 は有効 (ツリーを完全に隠した状態)。整数でない / 2000px 超は未設定として捨てる */
export function parseFileTreeHeight(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const height = Number(raw);
  if (height > FILE_TREE_HEIGHT_STORE_LIMIT) return null;
  return height;
}

export function createFileTreeHeightStore(storage?: DeviceSettingsStorage | null): DeviceSettingsStore<number | null> {
  return createDeviceSettingsStore<number | null>(storage, {
    key: FILE_TREE_HEIGHT_KEY,
    parse: parseFileTreeHeight,
    // null は保存を消す (ダブルクリックの「未指定へ戻す」)
    serialize: (height) => (height === null ? null : String(height)),
    fallback: () => null,
  });
}

/** アプリが使う既定の store */
export const fileTreeHeightStore = createFileTreeHeightStore();
