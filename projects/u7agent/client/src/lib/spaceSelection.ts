/**
 * スペース選択の規則と保存。選択は端末 (オリジン) ごとの表示設定なので localStorage の 1 キーに閉じ、
 * 読み取りの失敗は握らず呼び出し側へ通す (既定スペースを黙って表示しない)。
 */
import type { Space } from "server";
import { deviceSettingsStorage, type DeviceSettingsStorage } from "./deviceSettingsStore";

export const SPACE_SELECTION_KEY = "u7agent-space";
/** 保存値が無いときに選ぶスペース。会話の所属と同じ固定値 */
export const DEFAULT_SPACE_ID = "default";

/** 保存値と一覧の突き合わせ。欠落だけ既定へ倒し、未知・不正な値は undefined (復旧画面) にする */
export function selectedSpace(spaces: Space[], stored: string | null): Space | undefined {
  const id = stored === null ? DEFAULT_SPACE_ID : stored;
  return spaces.find((space) => space.id === id);
}

/**
 * mount 時の選択。URL の `space` を保存値より優先し、どちらも無ければ既定。一覧に無い値はここでは
 * 弾かず selectedSpace が復旧画面へ回す (`fromUrl` の確定後に保存値を更新する)。
 */
export function initialSpaceSelection(
  urlSpace: string | null,
  stored: string | null,
): { id: string; fromUrl: boolean } {
  if (urlSpace !== null) return { id: urlSpace, fromUrl: true };
  return { id: stored ?? DEFAULT_SPACE_ID, fromUrl: false };
}

/**
 * 起動元の会話リンク (通常クリック) で切り替えるスペース。所属が不明・現在と同じ・一覧に無ければ null にし、
 * 呼び出し側は現在のスペースで開く (未知の所属へ勝手に移らない)。
 */
export function ownerLinkSpace(
  ownerSpaceId: string | undefined,
  currentSpaceId: string,
  spaces: Space[],
): string | null {
  if (!ownerSpaceId || ownerSpaceId === currentSpaceId) return null;
  return spaces.some((space) => space.id === ownerSpaceId) ? ownerSpaceId : null;
}

/**
 * 削除後に選ぶスペース。選択中を消したときだけ既定へ倒し (呼び出し側が保存値も書く)、それ以外は
 * 選択を変えない (null)。自分で消した直後は既知なので復旧画面にしない。
 */
export function selectionAfterSpaceDelete(selectedId: string, removedId: string): string | null {
  return selectedId === removedId ? DEFAULT_SPACE_ID : null;
}

export type SpaceSelectionStore = {
  /** 保存値。無ければ null。読み取れないときは例外 (呼び出し側が復旧画面を出す) */
  read(): string | null;
  /** 選び直しの保存。保存領域が使えない環境でもその場の切替は止めない */
  write(id: string): void;
};

/**
 * localStorage の 1 キーで読み書きする。read は例外をそのまま通し、write だけを握る
 * (メモリの控えを持たないのは、保存先を読めないときに既定スペースを黙って出さないため)。
 */
export function createSpaceSelectionStore(storage?: DeviceSettingsStorage | null): SpaceSelectionStore {
  return {
    read() {
      const target = deviceSettingsStorage(storage);
      if (!target) throw new Error("会話スペースの保存先を使えません");
      return target.getItem(SPACE_SELECTION_KEY);
    },
    write(id) {
      const target = deviceSettingsStorage(storage);
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
