/**
 * ファイルツリー (FileBrowser) の幅の規則。bounds は本文のコンテナ幅 (= プレビューに残す幅) に依存する。
 */

import { createDeviceSettingsStore, type DeviceSettingsStorage, type DeviceSettingsStore } from "./deviceSettingsStore";

/** 選べる下限 (288px)。狭い窓では既定幅もここで止まる */
export const FILE_TREE_WIDTH_MIN = 288;
/** 左右 2 段になるコンテナ幅 (Tailwind の `@2xl` = 42rem)。これ未満は上下 2 段で、高さ (fileTreeHeight.ts) を選ぶ面 */
export const FILE_TREE_STACK_BREAKPOINT = 672;
/** 未指定のときの幅の上限。コンテナが広くても既定はこれ以上広げない */
export const FILE_TREE_WIDTH_DEFAULT_MAX = 400;
/** 未指定のときの幅のコンテナ比 (1/3)。プレビューを主、ツリーを従にする配分 */
export const FILE_TREE_WIDTH_DEFAULT_DIVISOR = 3;
/** 選べる上限。深さ 5 でも名前が 270px 以上見える幅 */
export const FILE_TREE_WIDTH_MAX = 560;
/** プレビューに残す最低幅。左右 2 段の境界 (@2xl = 672px) − 288px を下限とする */
export const FILE_TREE_PREVIEW_MIN_WIDTH = 384; /** キーボード操作 (→←) の 1 歩 */
export const FILE_TREE_WIDTH_STEP = 16;
export const FILE_TREE_WIDTH_STORE_LIMIT = 2000;
export const FILE_TREE_WIDTH_KEY = "u7agent-file-tree-width";

export type FileTreeWidthBounds = {
  min: number;
  max: number;
};

/**
 * 幅の下限 / 上限。`containerWidth` は本文の `@container` の clientWidth で、未計測 (0 以下) は null を
 * 返す (推測しない)。容器が 672px 以下では min == max になり、その帯ではハンドルを出さない。
 */
export function fileTreeWidthBounds(containerWidth: number): FileTreeWidthBounds | null {
  const container = Math.round(containerWidth);
  if (container <= 0) return null;
  const min = FILE_TREE_WIDTH_MIN;
  const max = Math.max(min, Math.min(FILE_TREE_WIDTH_MAX, container - FILE_TREE_PREVIEW_MIN_WIDTH));
  return { min, max };
}

/** 幅を選べるか。min == max (上下 2 段 / @2xl の境界ちょうど) ではハンドルを出さない */
export function canResizeFileTree(bounds: FileTreeWidthBounds | null): boolean {
  return bounds !== null && bounds.max > bounds.min;
}

/** 未指定のときの幅。コンテナの 1/3 を下限 (288) と上限 (400) で clamp する */
export function fileTreeWidthDefault(containerWidth: number): number {
  const ratio = Math.round(containerWidth / FILE_TREE_WIDTH_DEFAULT_DIVISOR);
  return Math.min(FILE_TREE_WIDTH_DEFAULT_MAX, Math.max(FILE_TREE_WIDTH_MIN, ratio));
}

/** 選べる幅へ丸める。state は clamp 前を持つため、表示のたびにここを通す */
export function clampFileTreeWidth(width: number, bounds: FileTreeWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/**
 * 表示幅。未指定 (null) はコンテナ幅の 1/3 に追随し、未計測 (0 以下) では clamp しない (下限または
 * 保存値)。`--file-tree-width` には常に px を入れる (未定義だと width:auto へ落ちてプレビューを潰す)。
 */
export function fileTreeWidth(requested: number | null, containerWidth: number): number {
  const bounds = fileTreeWidthBounds(containerWidth);
  if (bounds === null) return requested ?? FILE_TREE_WIDTH_MIN;
  return requested === null ? fileTreeWidthDefault(containerWidth) : clampFileTreeWidth(requested, bounds);
}

/** キーボード操作の 1 歩。端では clamp で止まる */
export function stepFileTreeWidth(width: number, delta: number, bounds: FileTreeWidthBounds): number {
  return clampFileTreeWidth(width + delta, bounds);
}

/** 保存値を読む。整数でない / 0 以下 / 2000px 超は未設定として捨てる */
export function parseFileTreeWidth(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const width = Number(raw);
  if (width <= 0 || width > FILE_TREE_WIDTH_STORE_LIMIT) return null;
  return width;
}

export function createFileTreeWidthStore(storage?: DeviceSettingsStorage | null): DeviceSettingsStore<number | null> {
  return createDeviceSettingsStore<number | null>(storage, {
    key: FILE_TREE_WIDTH_KEY,
    parse: parseFileTreeWidth,
    serialize: (width) => (width === null ? null : String(width)),
    fallback: () => null,
  });
}

/** アプリが使う既定の store */
export const fileTreeWidthStore = createFileTreeWidthStore();
