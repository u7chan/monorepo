/**
 * 左バー (Sidebar) の幅の規則。右パネル (sessionFilesPanel.ts) と形は同じで、
 * bounds が viewport に依存しない点だけが違う。
 */

import { createDeviceSettingsStore, type DeviceSettingsStorage, type DeviceSettingsStore } from "./deviceSettingsStore";
import { SIDEBAR_WIDTH } from "./layout";

/**
 * 選べる上限。viewport には依存させない (docked の下限 1200px でも main が 800px 残り、右パネル 360px と
 * チャット 320px の和 680px を上回る)。400px は名前 283px に相当し、これ以上は不要 (docs/ui-layout.md)。
 */
export const SIDEBAR_WIDTH_MAX = 400;
/** キーボード操作 (→←) の 1 歩 */
export const SIDEBAR_WIDTH_STEP = 16;
export const SIDEBAR_WIDTH_STORE_LIMIT = 2000;
export const SIDEBAR_WIDTH_KEY = "u7agent-sidebar-width";

export type SidebarWidthBounds = {
  min: number;
  max: number;
};

/**
 * 幅の下限 / 上限。どちらも定数で、下限は既定幅そのもの (今より狭くは選べない)。
 * viewport を引数に取らないのは、docked になる幅 (>= 1200px) ではどちらも収まるため。
 */
export function sidebarWidthBounds(): SidebarWidthBounds {
  return { min: SIDEBAR_WIDTH, max: SIDEBAR_WIDTH_MAX };
}

/** 選べる幅へ丸める。state は clamp 前を持つため、表示のたびにここを通す */
export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/** 表示幅。未指定 (null) は既定幅 = 下限 (252px) */
export function sidebarWidth(requested: number | null, bounds: SidebarWidthBounds): number {
  return requested === null ? bounds.min : clampSidebarWidth(requested, bounds);
}

/** キーボード操作の 1 歩。端では clamp で止まる */
export function stepSidebarWidth(width: number, delta: number, bounds: SidebarWidthBounds): number {
  return clampSidebarWidth(width + delta, bounds);
}

/** 保存値を読む。整数でない / 0 以下 / 2000px 超は未設定として捨てる */
export function parseSidebarWidth(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const width = Number(raw);
  if (width <= 0 || width > SIDEBAR_WIDTH_STORE_LIMIT) return null;
  return width;
}

export function createSidebarWidthStore(storage?: DeviceSettingsStorage | null): DeviceSettingsStore<number | null> {
  return createDeviceSettingsStore<number | null>(storage, {
    key: SIDEBAR_WIDTH_KEY,
    parse: parseSidebarWidth,
    serialize: (width) => (width === null ? null : String(width)),
    fallback: () => null,
  });
}

/** アプリが使う既定の store */
export const sidebarWidthStore = createSidebarWidthStore();
