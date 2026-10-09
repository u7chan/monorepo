/**
 * スペース選択の規則と保存。選択は端末 (オリジン) ごとの表示設定なので localStorage の 1 キーに閉じ、
 * 読み取りの失敗は握らず呼び出し側へ通す (通常スペースを黙って表示しない契約を、保存できない環境と
 * 混ぜないため)。DOM に触れるのは保存先の解決だけ (docs/frontend.md, docs/ui-layout.md)。
 */
import type { Space } from "server";

export const SPACE_SELECTION_KEY = "u7agent-space";
/** 保存値が無いときに選ぶスペース。会話の所属と同じ固定値 */
export const DEFAULT_SPACE_ID = "default";

/** 保存値と一覧の突き合わせ。欠落だけ既定へ倒し、未知・不正な値は undefined (復旧画面) にする */
export function selectedSpace(spaces: Space[], stored: string | null): Space | undefined {
  const id = stored === null ? DEFAULT_SPACE_ID : stored;
  return spaces.find((space) => space.id === id);
}

/**
 * mount 時の選択。URL の `space` (リンクの明示の指定) を保存値より優先し、どちらも無ければ既定。
 * 一覧に無い値はここでは弾かず、selectedSpace が復旧画面へ回す。
 * `fromUrl` は「開いたスペースを次の初期表示にする」ための印で、確定後に保存値を更新する。
 */
export function initialSpaceSelection(
  urlSpace: string | null,
  stored: string | null,
): { id: string; fromUrl: boolean } {
  if (urlSpace !== null) return { id: urlSpace, fromUrl: true };
  return { id: stored ?? DEFAULT_SPACE_ID, fromUrl: false };
}

export type SpaceSelectionStorage = Pick<Storage, "getItem" | "setItem">;

export type SpaceSelectionStore = {
  /** 保存値。無ければ null。読み取れないときは例外 (呼び出し側が復旧画面を出す) */
  read(): string | null;
  /** 選び直しの保存。保存領域が使えない環境でもその場の切替は止めない */
  write(id: string): void;
};

/**
 * localStorage の 1 キーで読み書きする。保存先は呼び出しごとに解決し、引数を省いたときだけ
 * window.localStorage を使う (accessor 自体が例外になる環境と、window が無いテストの両方に対応する)。
 * read は例外をそのまま通し、write だけを握る。
 */
export function createSpaceSelectionStore(storage?: SpaceSelectionStorage | null): SpaceSelectionStore {
  const resolve = (): SpaceSelectionStorage | null => (storage === undefined ? defaultSpaceStorage() : storage);
  return {
    read() {
      const target = resolve();
      if (!target) throw new Error("スペースの保存先を使えません");
      return target.getItem(SPACE_SELECTION_KEY);
    },
    write(id) {
      const target = resolve();
      if (!target) return;
      try {
        target.setItem(SPACE_SELECTION_KEY, id);
      } catch {
        // 保存できない環境でも切替は有効にする (次の起動では前の値へ戻り得る)
      }
    },
  };
}

/** アプリが使う既定の store */
export const spaceSelectionStore = createSpaceSelectionStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultSpaceStorage(): SpaceSelectionStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
