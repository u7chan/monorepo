/**
 * ダウンロード ZIP の除外規則。ワークスペース全体をそのまま配ると再生成できるものと依存が大半を占めるため、
 * **ベース名の完全一致・全階層**で落とす（パス指定や glob は持たない。判定は 1 箇所に閉じる）。
 * 実効値は設定ストア（`archive-settings.ts`）が 1 つに決め、health・download / check・walk が同じ値を使う。
 */
import { ARCHIVE_EXCLUDE_MAX_NAMES, isValidEntryName, SANDBOX_MAX_ENTRY_NAME_LENGTH } from "./sandbox/protocol";

/** 既定の除外名。`vendor`（Go / PHP で必要）と `public` / `lib` / `bin` / `docs`（成果物ではない）は入れない */
export const DEFAULT_ARCHIVE_EXCLUDE_NAMES: readonly string[] = [
  // 再生成物
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".git",
  // ビルド成果物
  "dist",
  "build",
  "out",
  ".output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "coverage",
  ".turbo",
  ".cache",
  ".parcel-cache",
];

/** 1 セグメント名の上限。設定 API が画面へ開示する値と、保存時の検証が同じものを見る */
export const ARCHIVE_EXCLUDE_MAX_NAME_LENGTH = SANDBOX_MAX_ENTRY_NAME_LENGTH;

/** 不正な名前の理由。件数と合わせて設定 API の 400 と画面のエラーに出す */
export const ARCHIVE_EXCLUDE_NAME_ERROR = "除外名に使えない名前があります";

/** 件数上限の理由 */
export const ARCHIVE_EXCLUDE_COUNT_ERROR = `除外名は ${ARCHIVE_EXCLUDE_MAX_NAMES} 件までです`;

// 定義はワイヤ契約 (protocol.ts) にあり、サンドボックスの query 検証と同じ値を使う。設定側の入口をここに揃える
export { ARCHIVE_EXCLUDE_MAX_NAMES };

/**
 * 保存する一覧を整える。前後の空白はパスとして意味を持たず（完全一致でしか照合しないため）黙って一致しなくなる。
 * 空文字は落とし、重複は先勝ちで畳む（順序と大文字小文字はそのまま保つ）。
 */
export function normalizeArchiveExcludeNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
}

/**
 * 保存前の検証。正規化後の一覧を受け取り、理由の文言を返す（undefined なら保存できる）。
 * 1 セグメント名の規則はアップロードの保存名と同じものを使う（空 / `.` / `..` / 区切り / 制御文字 / 長さ）。
 */
export function validateArchiveExcludeNames(names: readonly string[]): string | undefined {
  if (names.length > ARCHIVE_EXCLUDE_MAX_NAMES) return ARCHIVE_EXCLUDE_COUNT_ERROR;
  const invalid = names.find((name) => !isValidEntryName(name));
  return invalid === undefined ? undefined : `${ARCHIVE_EXCLUDE_NAME_ERROR}: ${invalid}`;
}

/**
 * 実効値を返す。overrides は設定ストアの保存値で、`undefined` / `null` のときだけ既定を使い、
 * 空配列は「除外なし」として尊重する（空を既定へ戻すと設定で全解除できない）。
 */
export function resolveArchiveExcludeNames(overrides?: readonly string[] | null): string[] {
  if (overrides == null) return [...DEFAULT_ARCHIVE_EXCLUDE_NAMES];
  return normalizeArchiveExcludeNames(overrides);
}
