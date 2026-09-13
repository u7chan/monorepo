/**
 * ファイルツリーの状態更新 (開閉・子のマージ・エラー保持)。DOM に依存しない純関数だけを置き、
 * 取得の起動と描画は FileTreeScreen が担う。キーは画面の root 相対パスで、画面の root が "."。
 * 画面の root からワークスペース root 相対 (GET /api/files の path) への変換は fileTreeFetchPath が担う。
 */
import type { FileEntry } from "../types";

export const FILE_TREE_ROOT = ".";

/**
 * 画面の root (ワークスペース root 相対) を正規化する。"" とワークスペース root 自身の絶対パス
 * (health.cwd) は "." へ畳む。GET /api/files の path は root 相対だけを受け付けるため、
 * 絶対パスを渡すと root 外として 400 になる。
 */
export function normalizeFileTreeRoot(cwd: string): string {
  const path = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path || path === FILE_TREE_ROOT) return FILE_TREE_ROOT;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return FILE_TREE_ROOT;
  return path;
}

/**
 * 画面の root 相対パス (FILE_TREE_ROOT が画面の root) を GET /api/files の path へ変換する。
 * 画面の root がワークスペース root ならそのまま、配下なら画面の root を前置する。
 */
export function fileTreeFetchPath(cwd: string, path: string): string {
  const root = normalizeFileTreeRoot(cwd);
  if (root === FILE_TREE_ROOT) return path;
  return path === FILE_TREE_ROOT ? root : `${root}/${path}`;
}

export type FileTreeDirectoryState = {
  open: boolean;
  /** 取得中 (プレースホルダ行を出す) */
  loading: boolean;
  /** 未取得は undefined。空ディレクトリ (空配列) と区別する */
  children?: FileEntry[];
  /** サーバーが件数上限で打ち切ったか */
  truncated?: boolean;
  /** このディレクトリだけの取得エラー (他のディレクトリの表示は維持する) */
  error?: string;
};

export type FileTreeState = Record<string, FileTreeDirectoryState>;

/** 開いたときに root から読み込む初期状態。 */
export function createFileTreeState(): FileTreeState {
  return { [FILE_TREE_ROOT]: { open: true, loading: false } };
}

/** parent ("." は画面の root) 配下の子のキー。 */
export function fileTreeChildPath(parent: string, name: string): string {
  return parent === FILE_TREE_ROOT ? name : `${parent}/${name}`;
}

/** 開閉を切り替える。取得済みの子は保持するので、開き直しで再取得は起きない。 */
export function toggleFileTreeDirectory(state: FileTreeState, path: string): FileTreeState {
  const node = state[path] ?? { open: false, loading: false };
  return { ...state, [path]: { ...node, open: !node.open } };
}

/** 取得開始。前回のエラーを消して、再試行できるようにする。 */
export function beginFileTreeLoad(state: FileTreeState, path: string): FileTreeState {
  const node = state[path] ?? { open: false, loading: false };
  return { ...state, [path]: { ...node, loading: true, error: undefined } };
}

/**
 * 取得結果を反映する。消えた子孫 (削除・リネーム) の状態は捨て、残った子孫の開閉と取得結果は保持する
 * (親を再読み込みしても、展開中のサブディレクトリが閉じたり再取得されたりしない)。
 */
export function applyFileTreeListing(
  state: FileTreeState,
  path: string,
  listing: { entries: FileEntry[]; truncated: boolean },
): FileTreeState {
  const node = state[path] ?? { open: false, loading: false };
  const prefix = path === FILE_TREE_ROOT ? "" : `${path}/`;
  const alive = new Set(listing.entries.map((entry) => entry.name));

  const next: FileTreeState = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(prefix) && !alive.has(firstSegment(key.slice(prefix.length)))) continue;
    next[key] = value;
  }
  next[path] = {
    ...node,
    loading: false,
    error: undefined,
    children: listing.entries,
    truncated: listing.truncated,
  };
  return next;
}

/** パスの先頭セグメント (直接の子の名前)。root 自身 ("") はどの子とも一致しない。 */
function firstSegment(rest: string): string {
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

/** 取得失敗。そのディレクトリにだけエラーを残し、他はそのまま維持する。 */
export function applyFileTreeError(state: FileTreeState, path: string, message: string): FileTreeState {
  const node = state[path] ?? { open: false, loading: false };
  return { ...state, [path]: { ...node, loading: false, error: message } };
}

/**
 * 再読み込み。取得済みの子とエラーを捨てて取り直す。開閉は保つ。
 * loading は残す (取得中の要求が解決したときにその結果が入る)。
 */
export function invalidateFileTree(state: FileTreeState): FileTreeState {
  const next: FileTreeState = {};
  for (const [key, node] of Object.entries(state)) {
    next[key] = { open: node.open, loading: node.loading };
  }
  return next;
}

/**
 * 取得が必要な「開いているが未取得」のディレクトリを、表示順 (親 → 子) に返す。
 * 取得中・エラーのディレクトリはここでは拾わない (再読み込みか再試行で取得する)。
 */
export function pendingFileTreeDirectories(state: FileTreeState): string[] {
  const pending: string[] = [];
  const walk = (path: string): void => {
    const node = state[path];
    if (!node?.open) return;
    if (!node.children) {
      if (!node.loading && !node.error) pending.push(path);
      return;
    }
    for (const entry of node.children) {
      if (entry.type === "dir") walk(fileTreeChildPath(path, entry.name));
    }
  };
  walk(FILE_TREE_ROOT);
  return pending;
}
