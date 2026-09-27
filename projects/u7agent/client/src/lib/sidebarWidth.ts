/**
 * 左バー (Sidebar) の幅の規則。幅は「その端末のその窓」に依存する表示設定なので、
 * どこで境界を引くかはこの純関数だけが決め、保存は localStorage の 1 キーに閉じる。
 * DOM に触れるのは保存先の解決だけ (docs/ui-layout.md)。
 * 右パネル (sessionFilesPanel.ts) と形は同じで、bounds が viewport に依存しない点だけが違う。
 */

import { SIDEBAR_WIDTH } from "./layout";

/**
 * 選べる上限。viewport には依存させない (docked の下限 1200px でも main が 800px 残り、
 * 右パネルの下限 min(360px, 30vw) = 360px とチャットの下限 320px の和 680px を上回る)。
 * 400px は名前 283px に相当し、実用上これ以上は不要 (docs/ui-layout.md)
 */
export const SIDEBAR_WIDTH_MAX = 400;
/** キーボード操作 (→←) の 1 歩 */
export const SIDEBAR_WIDTH_STEP = 16;
/** これより大きい保存値は壊れた値として捨てる */
export const SIDEBAR_WIDTH_STORE_LIMIT = 2000;
/** 保存キー。テーマ等と同じく端末ローカルの表示設定として持つ */
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

/** 表示幅。未指定 (null) は既定幅 = 下限 (従来の 252px) */
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

export type SidebarWidthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SidebarWidthStore = {
  /** 保存値。無ければ null (未設定) */
  read(): number | null;
  /** null は保存を消す (ダブルクリックの「未指定へ戻す」) */
  write(width: number | null): void;
};

/**
 * 選んだ幅を localStorage の 1 キーで読み書きする。保存領域が使えない環境 (private browsing 等)
 * でも操作を止めず、代わりに同じセッション内のメモリを使う。write が失敗した後でも、
 * 再読み込みするまでは選び直した幅を保つ (sessionFilesPanel.ts と同じ扱い)。
 */
export function createSidebarWidthStore(storage?: SidebarWidthStorage | null): SidebarWidthStore {
  // 一度でも読み書きしたら、以降はここが正 (書けなくても session 内は保つ)
  let memory: number | null | undefined;
  // 引数を省いたときは毎回引き直す (例外を投げる環境と、window が無いテストの両方に対応する)
  const resolve = (): SidebarWidthStorage | null => (storage === undefined ? defaultWidthStorage() : storage);

  return {
    read() {
      if (memory !== undefined) return memory;
      const target = resolve();
      if (!target) return null;
      try {
        memory = parseSidebarWidth(target.getItem(SIDEBAR_WIDTH_KEY));
        return memory;
      } catch {
        return null;
      }
    },
    write(width) {
      memory = width;
      const target = resolve();
      if (!target) return;
      try {
        if (width === null) target.removeItem(SIDEBAR_WIDTH_KEY);
        else target.setItem(SIDEBAR_WIDTH_KEY, String(width));
      } catch {
        // 保存できない。次に選び直したときにまた試す
      }
    },
  };
}

/** アプリが使う既定の store */
export const sidebarWidthStore = createSidebarWidthStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultWidthStorage(): SidebarWidthStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
