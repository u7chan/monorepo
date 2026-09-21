/**
 * ファイルツリーの状態更新 (開閉・子のマージ・エラー保持)。DOM に依存しない純関数だけを置き、
 * 取得の起動と描画は FileBrowser が担う。キーは root 相対パスで、root が "." のときはワークスペース root。
 * ページの root からワークスペース root 相対 (GET /api/files の path) への変換は fileTreeFetchPath が担う。
 */
import type { FileEntry } from "../types";

export const FILE_TREE_ROOT = ".";

// 絶対パス (health.cwd) のまま GET /api/files へ渡すと root 外として 400 になるため "." へ畳む
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
  loading: boolean;
  /** 未取得は undefined。空ディレクトリ (空配列) と区別する */
  children?: FileEntry[];
  truncated?: boolean;
  /** このディレクトリだけの取得エラー (他のディレクトリの表示は維持する) */
  error?: string;
};

export type FileTreeState = Record<string, FileTreeDirectoryState>;

export function createFileTreeState(): FileTreeState {
  return { [FILE_TREE_ROOT]: { open: true, loading: false } };
}

/** 開いているディレクトリ (root を除く) を state の順に返す。保存用 (children・loading・error は持たない) */
export function openFileTreeDirectories(state: FileTreeState): string[] {
  return Object.entries(state)
    .filter(([path, node]) => path !== FILE_TREE_ROOT && node.open)
    .map(([path]) => path);
}

/**
 * 保存された展開状態から初期状態を作る。root は常に開き、保存された子は open のまま持つ
 * (親を閉じた子の open を保存どおりに戻すため、親を勝手に開かない)。取得は可視の親から子へ
 * 辿る既存の経路のままで、未取得の子は開いたときに取りに行く。
 */
export function createFileTreeStateFromDirectories(dirs: string[]): FileTreeState {
  const state = createFileTreeState();
  for (const path of dirs) {
    if (fileTreeDirectoryState(state, path)) continue;
    setFileTreeDirectoryState(state, path, { open: true, loading: false });
  }
  return state;
}

export function fileTreeChildPath(parent: string, name: string): string {
  return parent === FILE_TREE_ROOT ? name : `${parent}/${name}`;
}

/** 親ディレクトリのパス。root 直下の子は FILE_TREE_ROOT になる */
export function fileTreeParentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? FILE_TREE_ROOT : path.slice(0, slash);
}

/** 削除の確認文言。path は画面の root 相対で、ツリーに見えているパスと一致させる。 */
export function fileTreeDeleteConfirm(path: string): string {
  return `「${path}」を削除しますか？この操作は取り消せません。`;
}

/**
 * 削除したファイルの行を一覧から落とす。children を持つ親だけを差し替えるので、
 * 展開中の子孫や他のディレクトリの状態はそのまま残る (ファイルを消しても親の再取得は不要)。
 * 該当行を持つ一覧が無いときは同じ object を返す。
 */
export function removeFileTreeEntry(state: FileTreeState, path: string): FileTreeState {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const parent = fileTreeParentPath(path);
  const node = fileTreeDirectoryState(state, parent);
  if (!node?.children) return state;
  const children = node.children.filter((entry) => entry.name !== name);
  if (children.length === node.children.length) return state;
  const next = { ...state };
  setFileTreeDirectoryState(next, parent, { ...node, children });
  return next;
}

/**
 * ディレクトリの状態を読む。パスには本文 (ファイル名) 由来の文字列が入るため、`__proto__` のような名前で
 * 継承プロパティを状態として拾わないよう own プロパティだけを見る。
 */
export function fileTreeDirectoryState(state: FileTreeState, path: string): FileTreeDirectoryState | undefined {
  return Object.hasOwn(state, path) ? state[path] : undefined;
}

/**
 * ディレクトリの状態を書く。`next[path] = node` はパスが `__proto__` のときプロトタイプの書き換えになり、
 * 状態に残らないため own プロパティとして定義する。
 */
function setFileTreeDirectoryState(state: FileTreeState, path: string, node: FileTreeDirectoryState): void {
  Object.defineProperty(state, path, { value: node, enumerable: true, writable: true, configurable: true });
}

/** 開閉を切り替える。取得済みの子は保持するので、開き直しで再取得は起きない。 */
export function toggleFileTreeDirectory(state: FileTreeState, path: string): FileTreeState {
  const node = fileTreeDirectoryState(state, path) ?? { open: false, loading: false };
  const next = { ...state };
  setFileTreeDirectoryState(next, path, { ...node, open: !node.open });
  return next;
}

/** 前回のエラーを消して、再試行できるようにする */
export function beginFileTreeLoad(state: FileTreeState, path: string): FileTreeState {
  const node = fileTreeDirectoryState(state, path) ?? { open: false, loading: false };
  const next = { ...state };
  setFileTreeDirectoryState(next, path, { ...node, loading: true, error: undefined });
  return next;
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
  const node = fileTreeDirectoryState(state, path) ?? { open: false, loading: false };
  const prefix = path === FILE_TREE_ROOT ? "" : `${path}/`;
  const alive = new Set(listing.entries.map((entry) => entry.name));

  const next: FileTreeState = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(prefix) && !alive.has(firstSegment(key.slice(prefix.length)))) continue;
    setFileTreeDirectoryState(next, key, value);
  }
  setFileTreeDirectoryState(next, path, {
    ...node,
    loading: false,
    error: undefined,
    children: listing.entries,
    truncated: listing.truncated,
  });
  return next;
}

function firstSegment(rest: string): string {
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

export function applyFileTreeError(state: FileTreeState, path: string, message: string): FileTreeState {
  const node = fileTreeDirectoryState(state, path) ?? { open: false, loading: false };
  const next = { ...state };
  setFileTreeDirectoryState(next, path, { ...node, loading: false, error: message });
  return next;
}

/**
 * 再読み込み。取得済みの子とエラーを捨てて取り直す。開閉は保つ。
 * loading は残す (取得中の要求が解決したときにその結果が入る)。
 */
export function invalidateFileTree(state: FileTreeState): FileTreeState {
  const next: FileTreeState = {};
  for (const [key, node] of Object.entries(state)) {
    setFileTreeDirectoryState(next, key, { open: node.open, loading: node.loading });
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
    const node = fileTreeDirectoryState(state, path);
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
