/**
 * ファイルプレビューの Markdown 本文に現れる相対パス (画像) を、表示中のファイルのディレクトリ基準で
 * ワークスペース root 相対へ解決する純関数 (チャット本文の cwd 基準とは違う)。
 */

/** scheme 付き (http: / data: / javascript: など) はローカルの参照として扱わない */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * src を表示中のファイルのディレクトリ基準で解決する。外部 URL・fragment だけ・root より上へ出る `..`
 * は null を返し、呼び出し側は入力をそのまま使う (CSP と raw の allowlist が実体の境界)。
 */
export function resolveMarkdownAssetPath(src: string, dir: string): string | null {
  const raw = src.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (SCHEME.test(raw)) return null;
  // `?` / `#` 以降はローカルのファイル名ではないため落とす (raw の配信 URL はパスだけを取る)
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  if (path === "") return null;
  // 先頭の `/` はワークスペース root からの絶対パスとして扱う
  const segments = path.startsWith("/") ? [] : splitDir(dir);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

function splitDir(dir: string): string[] {
  return dir.split("/").filter((segment) => segment !== "" && segment !== ".");
}
