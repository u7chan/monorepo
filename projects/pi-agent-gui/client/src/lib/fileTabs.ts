/**
 * ファイルプレビューのタブ (開いているパスの並びと表示中)。DOM に依存しない純関数だけを置き、
 * 取得と描画は FilePreview が担う。キーは fileTree と同じページ root 相対パス。
 */

/**
 * 同時に開けるタブ数。超えたら最も古いタブを閉じる。
 * プレビュー本文はタブごとに保持するため、この上限が保持量の上限でもある。
 */
export const FILE_TAB_LIMIT = 8;

export type FileTabsState = {
  /** 開いた順。選択では並びを変えない (IDE のタブと同じ) */
  paths: string[];
  /** 表示中のパス。タブが無ければ null */
  active: string | null;
};

export function createFileTabsState(): FileTabsState {
  return { paths: [], active: null };
}

/**
 * タブのラベル。同じ名前のタブが複数あるときだけ親ディレクトリを前置する (同名ファイルを区別する)。
 * 重複が無ければ名前だけ (IDE のタブと同じ)。
 */
export function fileTabLabels(paths: string[]): string[] {
  const names = paths.map(fileName);
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return paths.map((path, index) => ((counts.get(names[index]) ?? 0) > 1 ? lastSegments(path, 2) : names[index]));
}

function fileName(path: string): string {
  return lastSegments(path, 1);
}

function lastSegments(path: string, count: number): string {
  return path.split("/").slice(-count).join("/");
}

/** タブを開いて表示する。既に開いていれば並びは変えず表示だけを移す。 */
export function openFileTab(state: FileTabsState, path: string, limit = FILE_TAB_LIMIT): FileTabsState {
  if (state.paths.includes(path)) return { paths: state.paths, active: path };
  // 上限を超えた分は先頭 (最も古いタブ) から落とす。今開いたタブは末尾なので閉じない
  const paths = [...state.paths, path].slice(-limit);
  return { paths, active: path };
}

/** タブを閉じる。表示中でないタブを閉じても表示は動かさない。 */
export function closeFileTab(state: FileTabsState, path: string): FileTabsState {
  const index = state.paths.indexOf(path);
  if (index === -1) return state;
  const paths = state.paths.filter((item) => item !== path);
  if (state.active !== path) return { paths, active: state.active };
  // 閉じた位置へ繰り上がる右隣、無ければ左隣を表示する
  return { paths, active: paths[index] ?? paths[index - 1] ?? null };
}
