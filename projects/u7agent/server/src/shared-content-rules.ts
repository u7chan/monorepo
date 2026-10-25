/**
 * 共有（Cloudflare への静的公開）の除外規則。アーカイブ設定とは別の既定を持ち、**ベース名の完全一致・全階層**で落とす
 * （パス指定や glob は持たない。判定は 1 箇所に閉じる）。実効値は設定ストア（`shared-content-exclusions.ts`）が決め、
 * プレビューと公開が同じ値を使う。
 */
import { posix } from "node:path";
import { ARCHIVE_EXCLUDE_MAX_NAMES, isValidEntryName, SANDBOX_MAX_ENTRY_NAME_LENGTH } from "./sandbox/protocol";

/**
 * 既定の除外名。共有は「配る成果物のディレクトリ」を対象にするため、アーカイブの既定（`dist` / `build` / `out`）を
 * 入れない（対象そのものが `dist` のときに共有できなくなる）。`.env.*` は glob が無いので個別に列挙する。
 */
export const DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES: readonly string[] = [
  // リポジトリの管理情報と、その環境でしか使わない設定
  ".git",
  ".github",
  ".agents",
  "node_modules",
  // 依存と作業用の一時ファイル。成果物ではないうえ容量が大きく、既定で残すと ZIP の上限超過で公開できない
  ".venv",
  ".tmp",
  // テスト用のコードとフィクスチャ。配る中身ではないが、スナップショットなどで容量が大きくなりやすい
  "test",
  "tests",
  // エージェント向けの指示と説明。ドキュメントサイトを公開する用途では邪魔になるので既定で落とす
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  // 秘密値を持ちやすいファイル
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".DS_Store",
];

/** 1 セグメント名の上限。設定 API が画面へ開示する値と、保存時の検証が同じものを見る */
export const SHARED_CONTENT_EXCLUDE_MAX_NAME_LENGTH = SANDBOX_MAX_ENTRY_NAME_LENGTH;

/** 件数上限。サンドボックスの query 検証と同じ値を使う */
export const SHARED_CONTENT_EXCLUDE_MAX_NAMES = ARCHIVE_EXCLUDE_MAX_NAMES;

/** 不正な名前の理由。件数と合わせて設定 API の 400 と画面のエラーに出す */
export const SHARED_CONTENT_EXCLUDE_NAME_ERROR = "除外名に使えない名前があります";

/** 件数上限の理由 */
export const SHARED_CONTENT_EXCLUDE_COUNT_ERROR = `除外名は ${SHARED_CONTENT_EXCLUDE_MAX_NAMES} 件までです`;

/**
 * `index.html` を拒否する理由。名前は全階層一致なので、許可すると入れ子の `index.html`（`docs/index.html` など）も
 * 落とせてしまう。SPA の入口は常に要るため、一覧に入れられない名前にする。
 */
export const SHARED_CONTENT_EXCLUDE_INDEX_ERROR = "index.html は公開に必要なため除外できません";

/** 保存する一覧を整える。前後の空白を落とし、空文字を捨て、重複は先勝ちで畳む（順序と大文字小文字は保つ） */
export function normalizeSharedContentExcludeNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
}

/**
 * 保存前の検証。正規化後の一覧を受け取り、理由の文言を返す（undefined なら保存できる）。
 * 1 セグメント名の規則はアップロードの保存名と同じものを使う（空 / `.` / `..` / 区切り / 制御文字 / 長さ）。
 */
export function validateSharedContentExcludeNames(names: readonly string[]): string | undefined {
  if (names.length > SHARED_CONTENT_EXCLUDE_MAX_NAMES) return SHARED_CONTENT_EXCLUDE_COUNT_ERROR;
  if (names.includes("index.html")) return SHARED_CONTENT_EXCLUDE_INDEX_ERROR;
  const invalid = names.find((name) => !isValidEntryName(name));
  return invalid === undefined ? undefined : `${SHARED_CONTENT_EXCLUDE_NAME_ERROR}: ${invalid}`;
}

/**
 * 実効値を返す。overrides は設定ストアの保存値で、`undefined` / `null` のときだけ既定を使い、
 * 空配列は「除外なし」として尊重する（空を既定へ戻すと設定で全解除できない）。
 */
export function resolveSharedContentExcludeNames(overrides?: readonly string[] | null): string[] {
  if (overrides == null) return [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES];
  return normalizeSharedContentExcludeNames(overrides);
}

/**
 * 1 回の要求に使う実効値。対象ディレクトリのベース名と一致する名前だけを落とす。
 * 落とさないと `dist` を除外した状態で `dist/` を共有できず（サンドボックスは対象ディレクトリ名が除外名と
 * 一致すると 400）、設定と操作が自己矛盾する。副作用として、対象の直下以外にある同名ディレクトリも解禁される
 * （名前は全階層一致で、対象のベース名だけを見るため）。
 */
export function effectiveSharedContentExcludeNames(sourcePath: string, names: readonly string[]): string[] {
  const folder = posix.basename(sourcePath);
  return names.filter((name) => name !== folder);
}
