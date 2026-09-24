/**
 * ダウンロード ZIP の除外規則。ワークスペース全体をそのまま配ると再生成できるものと依存が大半を占めるため、
 * **ベース名の完全一致・全階層**で落とす（パス指定や glob は持たない。判定は 1 箇所に閉じる）。
 * 実効値はサンドボックス（走査）と BFF（health の開示）が同じ関数から引く。
 */

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

/**
 * 実効値を返す。overrides は将来の設定ストアからの上書きで、`undefined` / `null` のときだけ既定を使い、
 * 空配列は「除外なし」として尊重する（空を既定へ戻すと設定で全解除できない）。
 */
export function resolveArchiveExcludeNames(overrides?: readonly string[] | null): string[] {
  if (overrides == null) return [...DEFAULT_ARCHIVE_EXCLUDE_NAMES];
  // 前後の空白はパスとして意味を持たず（完全一致でしか照合しないため）黙って一致しなくなる。空文字も落とす
  return [...new Set(overrides.map((name) => name.trim()).filter((name) => name.length > 0))];
}
