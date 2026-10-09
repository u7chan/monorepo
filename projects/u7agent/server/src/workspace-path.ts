/**
 * 生成物をサンドボックスへ保存するときのパス変換。`generate_image` と `generate_speech` で
 * 同じ拒否規則・同じ文言を使うため、ツールの種別に依存しない層として切り出す。
 */

export interface ToolPathTarget {
  /** セッション cwd 相対の保存先ディレクトリ（"" は cwd 直下） */
  dir: string;
  /** 保存名（basename） */
  name: string;
}

/** `/` 区切りの相対パスを字句的に畳む。空セグメントと `.` は落とす */
function segmentsOf(value: string): string[] {
  return value.split("/").filter((segment) => segment !== "" && segment !== ".");
}

/**
 * `path` を cwd 相対の dir / name へ分ける。拒否規則は write / edit と同じ思想で、
 * `..` / 絶対パス / バックスラッシュ / 空の name（末尾 `/` を含む）を拒む。
 * root 相対への前置きは `rootRelativeDir` だけが行う。
 */
export function parseToolPath(rawPath: string): ToolPathTarget {
  if (rawPath.trim() === "") throw new Error("path が空です");
  if (rawPath.includes("\\")) throw new Error(`path にバックスラッシュは使えません: ${rawPath}`);
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
    throw new Error(`作業フォルダの外には保存できません: ${rawPath}`);
  }
  if (rawPath.endsWith("/")) throw new Error(`ファイル名が必要です: ${rawPath}`);
  const segments = segmentsOf(rawPath);
  if (segments.includes("..")) throw new Error(`作業フォルダの外には保存できません: ${rawPath}`);
  const name = segments.pop();
  if (!name) throw new Error(`ファイル名が必要です: ${rawPath}`);
  return { dir: segments.join("/"), name };
}

/** セッション cwd（root 相対）を前置する 1 段。projects.ts の cwd 解決とは混ぜない */
export function rootRelativeDir(cwd: string, dir: string): string {
  const root = segmentsOf(cwd).join("/");
  const child = segmentsOf(dir).join("/");
  if (root === "") return child;
  return child === "" ? root : `${root}/${child}`;
}

/** cwd 相対の保存先。ツール結果と read / Markdown の起点を揃えるため root 相対は返さない */
export function cwdRelativePath(dir: string, name: string): string {
  const child = segmentsOf(dir).join("/");
  return child === "" ? name : `${child}/${name}`;
}
