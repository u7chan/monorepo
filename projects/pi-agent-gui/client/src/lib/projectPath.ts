/**
 * ワークスペース root 相対パスの組み立て (プロジェクトのディレクトリ選択で使う)。
 * サーバーの正規化 (server/src/projects.ts) と同じく "/" 区切りで扱い、root は "." で表す。
 * DOM に依存しない。
 */

export const WORKSPACE_ROOT = ".";

/** parent ("." は root) 配下の子パス。 */
export function projectChildPath(parent: string, name: string): string {
  const segment = name.trim();
  return parent === WORKSPACE_ROOT ? segment : `${parent}/${segment}`;
}

/** 1 つ上の階層。root から上へは行けない (root を返す)。 */
export function parentWorkspacePath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? WORKSPACE_ROOT : path.slice(0, slash);
}

/** 末尾のセグメント (既存ディレクトリを登録するときの既定名)。root は空文字。 */
export function workspaceBaseName(path: string): string {
  return path === WORKSPACE_ROOT ? "" : path.slice(path.lastIndexOf("/") + 1);
}
