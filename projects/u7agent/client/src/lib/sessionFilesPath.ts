/**
 * 作業フォルダ面の帯に出すパスと、その ⋯ メニューの出し分け。パスの字面からセッション ID を
 * 読み取らず、末尾の段数だけを会話の種別で決める (ID の正は `envScope.sessionId`)。
 */
import { fileTreeAbsolutePath, isAbsolutePath, FILE_TREE_ROOT } from "./fileTree";
import type { RowMenuAction } from "./rowMenu";

/** この面の ⋯ に出す種別。行の ⋯ (FileRowActionKind) には出さない */
export type WorkFolderActionKind = "copy-session-id" | "copy-absolute-path";

export type WorkFolderAction = RowMenuAction<WorkFolderActionKind>;

/** 未所属会話の末尾。追加スペースの `<appdir>/spaces/<spaceId>/sessions/<id>` も最後の 2 段で同じ形になる */
const SCRATCH_TAIL_SEGMENTS = 2;
/** プロジェクト所属の末尾。登録ディレクトリを共有する会話が複数あるため、ディレクトリ名 1 段だけ残す */
const PROJECT_TAIL_SEGMENTS = 1;

export type WorkFolderPathParts = {
  /** 省略される前置き。区切りの `/` は含まない (空ならパス全体が末尾) */
  prefix: string;
  /** 幅を確保する末尾。前置きがあるときは先頭に区切りの `/` を含む */
  tail: string;
};

/**
 * パスを「省略される前置き」と「幅を確保する末尾」に分ける。`truncate` の末尾省略を反転させるのではなく、
 * 表示側で前置きだけを縮める (末尾は shrink-0) ために使う。末尾の段数を決めるのはセッション種別だけで、
 * 未取得 (undefined) はプロジェクト相当の 1 段に倒す。
 */
export function splitWorkFolderPath(path: string, projectSession?: boolean): WorkFolderPathParts {
  const segments = path
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length === 0) return { prefix: "", tail: "" };
  const count = projectSession === false ? SCRATCH_TAIL_SEGMENTS : PROJECT_TAIL_SEGMENTS;
  const prefix = segments.slice(0, -count).join("/");
  const tail = segments.slice(-count).join("/");
  return { prefix, tail: prefix === "" ? tail : `/${tail}` };
}

/**
 * 作業フォルダの絶対パス。行の「絶対パスをコピー」と同じく `health.cwd` (rootCwd) を前置して作る。
 * root が `.` のときは `fileTreeAbsolutePath` が末尾へ `/.` を付けるため、rootCwd 自身を返す。
 * 取れない値 (rootCwd 未取得 / 絶対パスでない) は別の値で代替せず undefined にする。
 */
export function workFolderAbsolutePath(rootCwd: string | undefined, root: string): string | undefined {
  if (rootCwd === undefined) return undefined;
  const normalized = rootCwd.replace(/\\/g, "/");
  if (!isAbsolutePath(normalized)) return undefined;
  const trimmedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmedRoot === "" || trimmedRoot === FILE_TREE_ROOT) return normalized.replace(/\/+$/, "") || "/";
  return fileTreeAbsolutePath(rootCwd, root, FILE_TREE_ROOT);
}

/**
 * 帯の段に必要な幅 (px)。末尾と ⋯ を縮めないために `TabToolbar` の context 最小幅として渡す
 * (context が 0 まで縮むと、shrink-0 の末尾が操作の下や overflow-hidden の外へはみ出す)。
 */
export function workFolderPathMinWidth(parts: { tail: number; menu: number; gap: number }): number {
  return Math.max(0, Math.ceil(parts.tail + parts.menu + parts.gap));
}

export const WORK_FOLDER_SESSION_MISSING = "会話がまだ作成されていません";
export const WORK_FOLDER_ABSOLUTE_MISSING = "ワークスペースの絶対パスを取得できていません";

export type WorkFolderMenuInput = {
  /** 選択中セッションの ID (`envScope.sessionId`)。空 = 会話がまだ無い (プロジェクト起点の新規会話) */
  sessionId?: string;
  /** 作業フォルダの絶対パス (`workFolderAbsolutePath`)。undefined = ワークスペースの絶対パスが未取得 */
  absolutePath?: string;
};

export type WorkFolderMenu = {
  /** ⋯ に出す項目 (セッション ID → 絶対パス)。全項目 disabled なら空 */
  actions: WorkFolderAction[];
  /** ⋯ を出すか。全項目 disabled では false (RowMenu は有効な最初の項目へ focus する前提) */
  menu: boolean;
  /** menu=false のときパスの下へ常設する理由 */
  reasons: string[];
};

/**
 * ⋯ の出し分け。項目は 2 つだけなので、片方だけ取れないときは項目ごと隠さず disabled + 理由を
 * 2 行目へ出す (隠すと残り 1 項目の理由が分からなくなる)。両方取れないときは ⋯ を出さない。
 */
export function workFolderMenu({ sessionId, absolutePath }: WorkFolderMenuInput): WorkFolderMenu {
  const sessionMissing = (sessionId ?? "") === "";
  const absoluteMissing = absolutePath === undefined;
  if (sessionMissing && absoluteMissing) {
    return { actions: [], menu: false, reasons: [WORK_FOLDER_SESSION_MISSING, WORK_FOLDER_ABSOLUTE_MISSING] };
  }
  return {
    menu: true,
    reasons: [],
    actions: [
      {
        kind: "copy-session-id",
        label: "セッション ID をコピー",
        ...(sessionMissing ? { description: WORK_FOLDER_SESSION_MISSING, disabled: true } : {}),
      },
      {
        kind: "copy-absolute-path",
        label: "絶対パスをコピー",
        ...(absoluteMissing ? { description: WORK_FOLDER_ABSOLUTE_MISSING, disabled: true } : {}),
      },
    ],
  };
}

/** コピー成功の読み上げ。項目ごとに何をコピーしたかを区別する */
export const WORK_FOLDER_COPY_STATUS: Record<WorkFolderActionKind, string> = {
  "copy-session-id": "セッション ID をコピーしました",
  "copy-absolute-path": "絶対パスをコピーしました",
};
