/** 右パネル (作業フォルダ) の幅の規則 */

import { createDeviceSettingsStore, type DeviceSettingsStorage, type DeviceSettingsStore } from "./deviceSettingsStore";

/** 未指定のときの幅の上限 (360px)。これより狭い幅は選べない */
export const SESSION_FILES_WIDTH_DEFAULT_MAX = 360;
/** 未指定のときの幅の viewport 比 (30vw) */
export const SESSION_FILES_WIDTH_DEFAULT_RATIO = 0.3;
/**
 * 選べる上限。FileBrowser は本文の container 幅が 672px (@2xl) に届くとツリーとプレビューを
 * 左右に並べ、かえって読める幅が減るため、その手前で止める
 */
export const SESSION_FILES_WIDTH_LIMIT = 671;
/**
 * チャット列に残したい幅。上限の基準であって保証ではない: パネルの最小幅が優先される帯
 * (720px では min == max) ではこれを割る (docs/ui-layout.md)。
 */
export const SESSION_FILES_CHAT_MIN_WIDTH = 320;
/** キーボード操作 (←→) の 1 歩 */
export const SESSION_FILES_WIDTH_STEP = 16;
export const SESSION_FILES_WIDTH_STORE_LIMIT = 2000;
export const SESSION_FILES_WIDTH_KEY = "u7agent-session-files-width";

export type SessionFilesPanelBounds = {
  min: number;
  max: number;
};

/**
 * 幅の下限 / 上限。`mainWidth` は「左バーを引いた main 列の幅」で、配置 (docked / overlay) を
 * 知っている呼び出し側が渡す。境界は整数に丸める (保存値と aria-valuemin|max|now を揃える)。
 */
export function sessionFilesPanelBounds(viewportWidth: number, mainWidth: number): SessionFilesPanelBounds {
  const min = Math.round(Math.min(SESSION_FILES_WIDTH_DEFAULT_MAX, viewportWidth * SESSION_FILES_WIDTH_DEFAULT_RATIO));
  const max = Math.max(min, Math.min(SESSION_FILES_WIDTH_LIMIT, Math.round(mainWidth) - SESSION_FILES_CHAT_MIN_WIDTH));
  return { min, max };
}

/** 幅を選べるか。min == max になる幅 (例: 720px) ではハンドルを出さない */
export function canResizeSessionFilesPanel(bounds: SessionFilesPanelBounds): boolean {
  return bounds.max > bounds.min;
}

/** 選べる幅へ丸める。state は clamp 前を持つため、表示のたびにここを通す */
export function clampSessionFilesPanelWidth(width: number, bounds: SessionFilesPanelBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/** 表示幅。未指定 (null) は最小幅 */
export function sessionFilesPanelWidth(requested: number | null, bounds: SessionFilesPanelBounds): number {
  return requested === null ? bounds.min : clampSessionFilesPanelWidth(requested, bounds);
}

/** キーボード操作の 1 歩。端では clamp で止まる */
export function stepSessionFilesPanelWidth(width: number, delta: number, bounds: SessionFilesPanelBounds): number {
  return clampSessionFilesPanelWidth(width + delta, bounds);
}

/** 保存値を読む。整数でない / 0 以下 / 2000px 超は未設定として捨てる */
export function parseSessionFilesPanelWidth(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const width = Number(raw);
  if (width <= 0 || width > SESSION_FILES_WIDTH_STORE_LIMIT) return null;
  return width;
}

export function createSessionFilesPanelWidthStore(
  storage?: DeviceSettingsStorage | null,
): DeviceSettingsStore<number | null> {
  return createDeviceSettingsStore<number | null>(storage, {
    key: SESSION_FILES_WIDTH_KEY,
    parse: parseSessionFilesPanelWidth,
    serialize: (width) => (width === null ? null : String(width)),
    fallback: () => null,
  });
}

/** アプリが使う既定の store */
export const sessionFilesPanelWidthStore = createSessionFilesPanelWidthStore();
