/**
 * シェルツールの子プロセスへ渡す環境変数を許可リスト方式で組み立てる
 * 純粋ユーティリティ。pi SDK に依存しない。
 *
 * 禁止リストではなく許可リストで組む。base (BFFの環境) から必要な変数だけ
 * を新しいオブジェクトへコピーし、process.env は一切変更しない。プロバイダー
 * キーや BASH_ENV / ENV / NODE_OPTIONS のような実行へ介入する変数は既定では
 * 継承しない。bash は `bash -c` (非対話・非ログイン) で起動されるため
 * プロファイルは読まれないが、BASH_ENV が継承されると読まれるため、
 * これも許可リストから外れていれば起動設定経由の再投入は起きない。
 */

/** 子プロセスに継承してもよい変数と、許可する理由。 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  // コマンドの解決に必須。
  "PATH",
  // git 等が ~/.gitconfig を参照するのに使う。認証ファイルも読めるが、
  // 同一コンテナ・同一ユーザーではファイルシステム経由で読めるため
  // 環境変数を削っても保証は変わらない (残存リスクは README を参照)。
  "HOME",
  // ロケールと文字コード。出力の解釈に影響する。
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // 一時ディレクトリ。ツール類のテンポラリ生成先。
  "TMPDIR",
  "TEMP",
  "TMP",
  // タイムスタンプ表示。
  "TZ",
  // 端末種別。一部の CLI が制御コード出力の判定に使う。
  "TERM",
];

/** Windows の子プロセスが動作するために必要な変数 (存在時のみ継承)。 */
const CHILD_ENV_ALLOWLIST_WINDOWS: readonly string[] = [
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
];

/**
 * pi SDK がシェルツールへ注入するセッションメタ変数。秘密ではなく、
 * ガイドライン上モデルから参照できることが期待されているため継承する。
 * BFF 自身が読む PI_MODEL / PI_THINKING 等の設定変数はここからは渡さない。
 */
const SESSION_ENV_KEYS: readonly string[] = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

/**
 * 追加で継承を許す変数名を BFF の環境から読む (カンマ区切り)。
 * HTTP_PROXY のように環境固有の変数が必要なときの逃し道。秘密値を
 * 指定しないこと。
 */
export function extraChildEnvNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PI_CHILD_ENV_EXTRA?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith("PI_"));
}

/**
 * base から許可リストに該当するキーだけを新しいオブジェクトへコピーする。
 * base は読み取りのみで、決して変更しない。
 *
 * PATH のみ Windows での大文字小文字の揺れ (Path) を吸収する。
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extraNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([
    ...CHILD_ENV_ALLOWLIST,
    ...(process.platform === "win32" ? CHILD_ENV_ALLOWLIST_WINDOWS : []),
    ...SESSION_ENV_KEYS,
    ...extraNames,
  ]);
  // PATH はプラットフォーム本来の表記 (Windows では Path の場合がある) を優先する。
  const pathKey =
    process.platform === "win32"
      ? (Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH")
      : "PATH";

  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(base)) {
    const isAllowed = allowed.has(key) || (key === pathKey && allowed.has("PATH"));
    if (isAllowed) childEnv[key] = base[key];
  }
  return childEnv;
}
