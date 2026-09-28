/**
 * ファイルツリー (FileBrowser) の幅の規則。幅は「その端末のその窓」に依存する表示設定なので、
 * どこで境界を引くかはこの純関数だけが決め、保存は localStorage の 1 キーに閉じる。
 * DOM に触れるのは保存先の解決だけ (docs/ui-layout.md)。
 * 左バー / 右パネルと違い、bounds は本文のコンテナ幅 (= プレビューに残す幅) に依存する。
 */

/** 選べる下限 = 従来の @2xl:w-72 (288px)。狭い窓では既定幅もここで止まる */
export const FILE_TREE_WIDTH_MIN = 288;
/** 未指定のときの幅の上限。コンテナが広くても既定はこれ以上広げない */
export const FILE_TREE_WIDTH_DEFAULT_MAX = 400;
/** 未指定のときの幅のコンテナ比 (1/3)。プレビューを主、ツリーを従にする配分 */
export const FILE_TREE_WIDTH_DEFAULT_DIVISOR = 3;
/** 選べる上限。深さ 5 でも名前が 270px 以上見える幅 */
export const FILE_TREE_WIDTH_MAX = 560;
/** プレビューに残す最低幅。今日の左右 2 段の境界 (@2xl = 672px) − 288px を下限として引き継ぐ */
export const FILE_TREE_PREVIEW_MIN_WIDTH = 384;
/** キーボード操作 (→←) の 1 歩 */
export const FILE_TREE_WIDTH_STEP = 16;
/** これより大きい保存値は壊れた値として捨てる */
export const FILE_TREE_WIDTH_STORE_LIMIT = 2000;
/** 保存キー。テーマ等と同じく端末ローカルの表示設定として持つ */
export const FILE_TREE_WIDTH_KEY = "u7agent-file-tree-width";

export type FileTreeWidthBounds = {
  min: number;
  max: number;
};

/**
 * 幅の下限 / 上限。`containerWidth` は本文の `@container` の `clientWidth` (整数)。
 * 未計測 (0 以下) は null を返す (既定も上限もコンテナ幅に依存するため、推測しない)。
 * 上限は `max(min, ...)` で clamp するので、コンテナ < 672px (= 上下 2 段) と `@2xl` の
 * 境界ちょうどでは min == max になり、その帯ではハンドルを出さない (canResizeFileTree)。
 */
export function fileTreeWidthBounds(containerWidth: number): FileTreeWidthBounds | null {
  const container = Math.round(containerWidth);
  if (container <= 0) return null;
  const min = FILE_TREE_WIDTH_MIN;
  const max = Math.max(min, Math.min(FILE_TREE_WIDTH_MAX, container - FILE_TREE_PREVIEW_MIN_WIDTH));
  return { min, max };
}

/** 幅を選べるか。min == max (上下 2 段 / @2xl の境界ちょうど) ではハンドルを出さない */
export function canResizeFileTree(bounds: FileTreeWidthBounds | null): boolean {
  return bounds !== null && bounds.max > bounds.min;
}

/** 未指定のときの幅。コンテナの 1/3 を下限 (288) と上限 (400) で clamp する */
export function fileTreeWidthDefault(containerWidth: number): number {
  const ratio = Math.round(containerWidth / FILE_TREE_WIDTH_DEFAULT_DIVISOR);
  return Math.min(FILE_TREE_WIDTH_DEFAULT_MAX, Math.max(FILE_TREE_WIDTH_MIN, ratio));
}

/** 選べる幅へ丸める。state は clamp 前を持つため、表示のたびにここを通す */
export function clampFileTreeWidth(width: number, bounds: FileTreeWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/**
 * 表示幅。未指定 (null) はコンテナ幅に追随する既定 (1/3)。未計測 (0 以下) では上限が
 * 決まらないため clamp せず、未指定なら下限、保存値があればその値をそのまま使う。
 * `--file-tree-width` には常に px を入れる (未定義の var() を渡すと `@2xl:w-(--file-tree-width)`
 * が width:auto へ落ち、flex-none のまま内容幅まで広がってプレビューを潰す)。
 */
export function fileTreeWidth(requested: number | null, containerWidth: number): number {
  const bounds = fileTreeWidthBounds(containerWidth);
  if (bounds === null) return requested ?? FILE_TREE_WIDTH_MIN;
  return requested === null ? fileTreeWidthDefault(containerWidth) : clampFileTreeWidth(requested, bounds);
}

/** キーボード操作の 1 歩。端では clamp で止まる */
export function stepFileTreeWidth(width: number, delta: number, bounds: FileTreeWidthBounds): number {
  return clampFileTreeWidth(width + delta, bounds);
}

/** 保存値を読む。整数でない / 0 以下 / 2000px 超は未設定として捨てる */
export function parseFileTreeWidth(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const width = Number(raw);
  if (width <= 0 || width > FILE_TREE_WIDTH_STORE_LIMIT) return null;
  return width;
}

export type FileTreeWidthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type FileTreeWidthStore = {
  /** 保存値。無ければ null (未設定) */
  read(): number | null;
  /** null は保存を消す (ダブルクリックの「未指定へ戻す」) */
  write(width: number | null): void;
};

/**
 * 選んだ幅を localStorage の 1 キーで読み書きする。保存領域が使えない環境 (private browsing 等)
 * でも操作を止めず、代わりに同じセッション内のメモリを使う。write が失敗した後でも、
 * 再読み込みするまでは選び直した幅を保つ (sidebarWidth.ts と同じ扱い)。
 */
export function createFileTreeWidthStore(storage?: FileTreeWidthStorage | null): FileTreeWidthStore {
  // 一度でも読み書きしたら、以降はここが正 (書けなくても session 内は保つ)
  let memory: number | null | undefined;
  // 引数を省いたときは毎回引き直す (例外を投げる環境と、window が無いテストの両方に対応する)
  const resolve = (): FileTreeWidthStorage | null => (storage === undefined ? defaultWidthStorage() : storage);

  return {
    read() {
      if (memory !== undefined) return memory;
      const target = resolve();
      if (!target) return null;
      try {
        memory = parseFileTreeWidth(target.getItem(FILE_TREE_WIDTH_KEY));
        return memory;
      } catch {
        return null;
      }
    },
    write(width) {
      memory = width;
      const target = resolve();
      if (!target) return;
      try {
        if (width === null) target.removeItem(FILE_TREE_WIDTH_KEY);
        else target.setItem(FILE_TREE_WIDTH_KEY, String(width));
      } catch {
        // 保存できない。次に選び直したときにまた試す
      }
    },
  };
}

/** アプリが使う既定の store */
export const fileTreeWidthStore = createFileTreeWidthStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultWidthStorage(): FileTreeWidthStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
