/**
 * ファイルプレビューのタブ (開いているパスの並びと表示中)。DOM に依存しない純関数だけを置き、
 * 取得と描画は FilePreview が担う。キーは fileTree と同じページ root 相対パス。
 */

import { isHtmlPath } from "./fileCode";

/**
 * 同時に開けるタブ数。超えたら最も古いタブを閉じる。
 * プレビュー本文はタブごとに保持するため、この上限が保持量の上限でもある。
 */
export const FILE_TAB_LIMIT = 8;

/** タブごとの表示の切替。ソース (行番号付きの本文) か、HTML を描画したプレビューか */
export type PreviewMode = "source" | "preview";

/** タブごとに保持する表示モード。キーはページ root 相対パス */
export type PreviewModes = Record<string, PreviewMode>;

/**
 * タブの表示モード。既定は HTML だけプレビューで、他の拡張子はソース。
 * 本文と同じく own property だけを見る (`constructor` や `__proto__` のような名前のパスを「選択済み」と誤認しないため)。
 */
export function previewModeFor(modes: PreviewModes, path: string): PreviewMode {
  const mode = Object.hasOwn(modes, path) ? modes[path] : undefined;
  return mode ?? (isHtmlPath(path) ? "preview" : "source");
}

/** 表示モードを選び直す。computed key で書く (own property になり、`__proto__` でもプロトタイプを書き換えない) */
export function withPreviewMode(modes: PreviewModes, path: string, mode: PreviewMode): PreviewModes {
  return { ...modes, [path]: mode };
}

/** 閉じたタブの選択を捨てる (選択はタブを閉じるまで)。中身が変わらないときは同じ object を返す */
export function dropClosedPreviewModes(modes: PreviewModes, paths: string[]): PreviewModes {
  const kept = Object.entries(modes).filter(([path]) => paths.includes(path));
  return kept.length === Object.keys(modes).length ? modes : Object.fromEntries(kept);
}

/**
 * 全画面を続ける条件。全画面を出したタブ (`fullscreenPath`) をそのまま HTML のプレビューで表示している間だけ
 * true になる。表示対象が変わったとき (他タブへの切替・閉じて繰り上がった場合。HTML 同士でも) と、
 * ソース表示へ切り替えたときは false になり、全画面を解除する。
 */
export function keepsFullscreenPreview(fullscreenPath: string | null, activePath: string, mode: PreviewMode): boolean {
  if (fullscreenPath === null || fullscreenPath !== activePath) return false;
  return isHtmlPath(activePath) && mode === "preview";
}

export type FileTabsState = {
  /** 開いた順。選択では並びを変えない (IDE のタブと同じ) */
  paths: string[];
  /** 表示中のパス。タブが無ければ null */
  active: string | null;
};

/** タブごとに保持するプレビュー本文。キーはページ root 相対パス */
export type PreviewResults = Record<string, { text?: string; error?: string }>;

export function createFileTabsState(): FileTabsState {
  return { paths: [], active: null };
}

/**
 * 保存値からタブの初期状態を作る。active が paths に無ければ末尾 (最後に開いたタブ) へ倒す。
 * decode 側で検証済みでも、ここで 1 箇所に閉じておく (呼び出し側の誤りで active が浮くのを防ぐ)。
 */
export function restoreFileTabsState(paths: string[], active: string | null): FileTabsState {
  if (paths.length === 0) return createFileTabsState();
  const restored = active && paths.includes(active) ? active : null;
  return { paths, active: restored ?? paths[paths.length - 1] ?? null };
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

/**
 * 保持している本文を読む。通常の object は継承プロパティも返すため、`constructor` / `toString` /
 * `__proto__` のような名前のパスを「保持済み」と誤認しないよう、own property だけを見る。
 * (書き込み側の `{ ...prev, [path]: value }` は computed key なので own property になる)
 */
export function readPreview(results: PreviewResults, path: string): PreviewResults[string] | undefined {
  return Object.hasOwn(results, path) ? results[path] : undefined;
}

/** 閉じたタブの本文を捨てる。中身が変わらないときは同じ object を返す (再 render を起こさない) */
export function dropClosedPreviews(results: PreviewResults, paths: string[]): PreviewResults {
  const kept = Object.entries(results).filter(([path]) => paths.includes(path));
  return kept.length === Object.keys(results).length ? results : Object.fromEntries(kept);
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
