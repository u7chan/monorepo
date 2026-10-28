export type ViewMode = "standard" | "compact";

/** 端末ごとの好みなので、サーバーへは送らずブラウザにだけ置く。 */
export const VIEW_MODE_STORAGE_KEY = "usage-portal:view-mode";

type ViewModeStorage = Pick<Storage, "getItem" | "setItem">;

/** 保存値は手で書き換えられる。知らない値は推移まで見える標準表示に倒す。 */
export function parseViewMode(value: string | null): ViewMode {
  return value === "compact" ? "compact" : "standard";
}

/** localStorage はプライベートモードなどで例外を投げる。読めなくても既定の表示で開く。 */
export function readViewMode(storage: ViewModeStorage | null): ViewMode {
  if (!storage) {
    return "standard";
  }

  try {
    return parseViewMode(storage.getItem(VIEW_MODE_STORAGE_KEY));
  } catch {
    return "standard";
  }
}

/** 保存できなくても、その場の切り替えは効かせる（呼び出し側は state を先に変える）。 */
export function writeViewMode(storage: ViewModeStorage | null, mode: ViewMode): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 書き込めない環境では次回の訪問で既定に戻るだけ。表示は止めない。
  }
}

/** プロパティの参照自体が例外になる環境（ストレージが禁止された iframe など）がある。 */
export function browserStorage(): ViewModeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
