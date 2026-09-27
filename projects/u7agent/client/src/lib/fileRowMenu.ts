/**
 * ファイルツリーの行の ⋯ メニュー。行の操作の出し分け・文言と、メニューの位置 / キーボード移動の
 * 計算だけを持つ純関数を集める (描画と popover の操作は `client/src/components/RowMenu.tsx`)。
 */
import { isArchiveExcludedName } from "./archive";

export type FileRowActionKind = "download" | "rename" | "delete";

export type FileRowAction = {
  kind: FileRowActionKind;
  label: string;
  /** 2 行目。押す前に開示したい条件がある操作だけ持つ */
  description?: string;
  danger?: boolean;
};

/** 出し分けの材料。行の形 (`FileEntry`) と画面の prop だけで、API も DOM も見ない */
export type FileRowActionsInput = {
  name: string;
  type: "file" | "dir";
  symlink?: boolean;
  canRename: boolean;
  readOnly: boolean;
  /** ワークスペースの除外名 (設定ストアの実効値)。除外名の行にはダウンロードを出さない */
  excludeNames: readonly string[];
};

/**
 * 行に出す操作を ダウンロード → リネーム → 削除 の順で返す。`null` = 行の操作領域ごと出さない (読み取り専用)、
 * `[]` = 領域は出すが項目が無い (= 空きスロット 1 個) と契約を分ける (呼び出し側で `readOnly` と区別できないため)。
 */
export function fileRowActions({
  name,
  type,
  symlink,
  canRename,
  readOnly,
  excludeNames,
}: FileRowActionsInput): FileRowAction[] | null {
  if (readOnly) return null;
  const actions: FileRowAction[] = [];
  // ダウンロードは通常ファイルとディレクトリに出す。symlink は api が 400 で拒否し、除外名の行は zip に入らない
  if (!symlink && !isArchiveExcludedName(name, excludeNames)) {
    actions.push(
      type === "dir"
        ? // ディレクトリの zip は除外を含むため、押す前の開示を 2 行目へ移す (以前の title 相当)
          { kind: "download", label: "ZIP でダウンロード", description: "ビルド成果物と依存を除く" }
        : { kind: "download", label: "ダウンロード" },
    );
  }
  // リネームはフォルダ行だけに出す (UI からファイルは改名できない)。symlink はサンドボックスが 400 で拒否する
  if (canRename && type === "dir" && !symlink) actions.push({ kind: "rename", label: "名前を変更" });
  if (!symlink) actions.push({ kind: "delete", label: "削除", danger: true });
  return actions;
}

export type RowMenuRect = Pick<DOMRect, "top" | "left" | "right" | "bottom">;

/** メニューの入れ物と ⋯ の間隔 / viewport の端からの余白 (px) */
export const ROW_MENU_GAP = 4;
export const ROW_MENU_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * メニューの `fixed` 座標。既定は ⋯ の右下 (右端をそろえる) に置き、右端 / 下端で収まらないときは
 * 左 / 上へ倒して viewport の内側へ clamp する (メニューが viewport より大きい場合は上 / 左に寄せる)。
 */
export function rowMenuPlacement(
  anchor: RowMenuRect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  let left = anchor.right - menu.width;
  if (left < ROW_MENU_MARGIN) left = anchor.left;
  left = clamp(left, ROW_MENU_MARGIN, viewport.width - menu.width - ROW_MENU_MARGIN);

  const below = anchor.bottom + ROW_MENU_GAP;
  const above = anchor.top - ROW_MENU_GAP - menu.height;
  const top = below + menu.height > viewport.height - ROW_MENU_MARGIN && above >= ROW_MENU_MARGIN ? above : below;
  return { left, top: clamp(top, ROW_MENU_MARGIN, viewport.height - menu.height - ROW_MENU_MARGIN) };
}

/** ⋯ が clip (ツリーのスクロール枠 / viewport) の内側に完全に見えているか */
export function rowMenuAnchorVisible(anchor: RowMenuRect, clips: readonly RowMenuRect[]): boolean {
  return clips.every(
    (clip) =>
      anchor.top >= clip.top && anchor.bottom <= clip.bottom && anchor.left >= clip.left && anchor.right <= clip.right,
  );
}

/** ↑↓ の移動先。端では止まる (循環しない)。`index` が -1 (フォーカスが項目の外) のときは端の項目へ入る */
export function nextRowMenuIndex(index: number, length: number, direction: "next" | "previous"): number {
  if (length <= 0) return -1;
  if (index < 0) return direction === "next" ? 0 : length - 1;
  return direction === "next" ? Math.min(index + 1, length - 1) : Math.max(index - 1, 0);
}
