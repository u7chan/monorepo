/**
 * ファイルツリーの行の ⋯ メニューの出し分けだけを持つ (文言はここ、項目の型と位置 / キーボード移動の
 * 計算は `client/src/lib/rowMenu.ts`、描画は `client/src/components/RowMenu.tsx`)。
 */
import { isArchiveExcludedName } from "./archive";
import type { RowMenuAction, RowMenuActionKind } from "./rowMenu";

/** ファイルツリーが出せる種別 (new-chat / pin / move はサイドバー専用) */
export type FileRowActionKind = Exclude<
  RowMenuActionKind,
  "new-chat" | "pin" | "move" | "handoff" | "diagnostics" | "raw-log"
>;

export type FileRowAction = RowMenuAction<FileRowActionKind>;

/** 出し分けの材料。行の形 (`FileEntry`) と画面の prop だけで、API も DOM も見ない */
export type FileRowActionsInput = {
  name: string;
  type: "file" | "dir";
  symlink?: boolean;
  canRename: boolean;
  readOnly: boolean;
  /** ワークスペースの除外名 (設定ストアの実効値)。除外名の行にはダウンロードを出さない */
  excludeNames: readonly string[];
  /** 行の絶対パス。undefined = ワークスペース root の絶対パス (health.cwd) が未取得で、その項目を出さない */
  absolutePath?: string;
};

/**
 * 行に出す操作を パスをコピー → 絶対パスをコピー → ダウンロード → リネーム → 削除 の順で返す。`null` = 行の操作領域ごと出さない
 * (読み取り専用)、`[]` = 領域は出すが項目が無い (= 空きスロット 1 個) と契約を分ける (呼び出し側で `readOnly`
 * と区別できないため)。パスはどの行でも取れるので、現在の出し分けは `[]` を返さない。
 */
export function fileRowActions({
  name,
  type,
  symlink,
  canRename,
  readOnly,
  excludeNames,
  absolutePath,
}: FileRowActionsInput): FileRowAction[] | null {
  if (readOnly) return null;
  // 相対パスはファイル / ディレクトリ / symlink のどれでも取れる (危険な削除は末尾に残す)
  const actions: FileRowAction[] = [
    // コピーする字面の基準はラベルだけで決まるため singleColumn では隠す
    { kind: "copy-path", label: "パスをコピー", description: "ツリーの root からの相対パス", descriptionKind: "note" },
  ];
  // 絶対パスは health.cwd を前置して組み立てる。未取得の間は字面を作れないので項目ごと出さない
  if (absolutePath !== undefined) {
    actions.push({ kind: "copy-absolute-path", label: "絶対パスをコピー" });
  }
  // ダウンロードは通常ファイルとディレクトリに出す。symlink は api が 400 で拒否し、除外名の行は zip に入らない
  if (!symlink && !isArchiveExcludedName(name, excludeNames)) {
    actions.push(
      type === "dir"
        ? // ディレクトリの zip は除外を含むため、押す前の開示を 2 行目へ移す (以前の title 相当)
          {
            kind: "download",
            label: "ZIP でダウンロード",
            description: "ビルド成果物と依存を除く",
            descriptionKind: "disclosure",
          }
        : { kind: "download", label: "ダウンロード" },
    );
  }
  // リネームはフォルダ行だけに出す (UI からファイルは改名できない)。symlink はサンドボックスが 400 で拒否する
  if (canRename && type === "dir" && !symlink) actions.push({ kind: "rename", label: "名前を変更" });
  if (!symlink) actions.push({ kind: "delete", label: "削除", danger: true });
  return actions;
}
