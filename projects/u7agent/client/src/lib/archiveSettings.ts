/**
 * アーカイブの除外名の下書き（一覧）と検証。DOM に依存しない純ロジックだけを置き、画面はここが返す値を描くだけにする
 * （文言と規則をテストで固定するため）。検証規則はサーバー（`server/src/archive-rules.ts`）と同じで、
 * 長さの上限は API の `maxNameLength` を受けて二重持ちしない。
 */
import type { ArchiveSettingsResponse } from "../types";

export type ArchiveSettingsDraft = {
  /** 保存する一覧（順序そのまま。重複は追加時に畳む） */
  excludeNames: string[];
};

/** 設定の読み込み前と下書きの破棄で使う初期値 */
export const EMPTY_ARCHIVE_DRAFT: ArchiveSettingsDraft = { excludeNames: [] };

/** 保存済みの設定から下書きを作る。未設定のときは実効値（= 既定の一覧）から始める */
export function draftFromSettings(settings: ArchiveSettingsResponse | null): ArchiveSettingsDraft {
  return { excludeNames: [...(settings?.excludeNames ?? [])] };
}

/** 下書きが保存済みから変わっているか。[保存] の有効化と [破棄] の表示に使う */
export function archiveSettingsDirty(draft: ArchiveSettingsDraft, settings: ArchiveSettingsResponse | null): boolean {
  if (!settings) return false;
  return !sameNames(draft.excludeNames, settings.excludeNames);
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * 一覧へ追加する。前後の空白は落とし、空と重複（先勝ち）と件数上限では何もしない
 * （名前そのものの妥当性は保存時に見て、不正なら理由を画面へ出す）。
 */
export function addExcludeName(draft: ArchiveSettingsDraft, raw: string, maxNames: number): ArchiveSettingsDraft {
  const name = raw.trim();
  if (!name || draft.excludeNames.includes(name) || draft.excludeNames.length >= maxNames) return draft;
  return { excludeNames: [...draft.excludeNames, name] };
}

export function removeExcludeName(draft: ArchiveSettingsDraft, name: string): ArchiveSettingsDraft {
  return { excludeNames: draft.excludeNames.filter((entry) => entry !== name) };
}

/** 保存前の検証。1 セグメント名の規則（空 / `.` / `..` / 区切り / 制御文字 / 長さ）と件数上限 */
export function validateExcludeName(name: string, maxNameLength: number): string | undefined {
  if (!name) return "除外名に使えない名前があります: （空）";
  if (name.length > maxNameLength) return `除外名に使えない名前があります: ${name}`;
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    return `除外名に使えない名前があります: ${name}`;
  }
  // oxlint-disable-next-line no-control-regex -- ファイル名の制御文字を弾くための検出（サーバーと同じ規則）。
  if (/[\u0000-\u001f\u007f]/.test(name)) return `除外名に使えない名前があります: ${name}`;
  return undefined;
}

/** 一覧全体の検証。件数上限を見てから、最初の不正名で理由を返す */
export function validateExcludeNames(
  draft: ArchiveSettingsDraft,
  maxNames: number,
  maxNameLength: number,
): string | undefined {
  if (draft.excludeNames.length > maxNames) return `除外名は ${maxNames} 件までです`;
  for (const name of draft.excludeNames) {
    const reason = validateExcludeName(name, maxNameLength);
    if (reason) return reason;
  }
  return undefined;
}
