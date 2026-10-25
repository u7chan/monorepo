/**
 * ファイルツリーの行の ⋯ メニューの出し分けだけを持つ (文言はここ、項目の型と位置 / キーボード移動の
 * 計算は `client/src/lib/rowMenu.ts`、描画は `client/src/components/RowMenu.tsx`)。
 */
import { isArchiveExcludedName } from "./archive";
import type { RowMenuAction, RowMenuActionKind } from "./rowMenu";

/** ファイルツリーが出せる種別 (new-chat / pin / move / handoff はサイドバー専用) */
export type FileRowActionKind = Exclude<RowMenuActionKind, "new-chat" | "pin" | "move" | "handoff">;

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
  /**
   * 「共有」(Cloudflare への静的公開) を出せる面か。作業フォルダ面だけが true を渡す
   * (共有 API の directory がセッションの作業フォルダ相対なので、設定 → ファイル では出さない)
   */
  canShare?: boolean;
  /**
   * ツリー root 直下の `index.html` から作業フォルダ自身を共有できるか。プロジェクト会話と
   * 会話が未確定の面は false (呼び出し側の `canShareSessionRoot`)
   */
  canShareSessionRoot?: boolean;
  /** 行の深さ。0 = ツリーの root 直下。省略は root 自身 (深さ 0) と区別できず、root 専用の項目を出さない */
  depth?: number;
};

/** root 直下の `index.html`。この行からだけ作業フォルダ全体を公開できる */
const SESSION_ROOT_SHARE_ENTRY = "index.html";

/**
 * ⋯ の「共有」に渡すパス。ディレクトリ行は自分自身、root 直下の `index.html` 行は親。
 * ファイル行の `path` を使い回さない（ファイル自身を指し、作業フォルダ全体を公開できない）。
 */
export function fileRowShareTarget(input: { type: "file" | "dir"; path: string; parent: string }): string {
  return input.type === "dir" ? input.path : input.parent;
}

/**
 * 行に出す操作を パスをコピー → 絶対パスをコピー → 共有 (ディレクトリ行と root 直下の `index.html` 行だけ) → ダウンロード → リネーム → 削除 の順で返す。
 * `null` = 行の操作領域ごと出さない (読み取り専用)、`[]` = 領域は出すが項目が無い (= 空きスロット 1 個) と契約を
 * 分ける (呼び出し側で `readOnly` と区別できないため)。パスはどの行でも取れるので、現在の出し分けは `[]` を返さない。
 */
export function fileRowActions({
  name,
  type,
  symlink,
  canRename,
  readOnly,
  excludeNames,
  absolutePath,
  canShare = false,
  canShareSessionRoot = false,
  depth,
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
  // 共有はディレクトリ単位 (index.html の確認は公開ジョブが行うのでクライアントでは見ない)。
  // サービス (一時プレビュー) との違いは押す前に知る条件なので singleColumn でも残す
  if (canShare && type === "dir" && !symlink) {
    actions.push({
      kind: "share",
      label: "共有",
      description: "Cloudflare へ静的公開（サービスは一時プレビュー）",
      descriptionKind: "disclosure",
    });
  }
  // 作業フォルダ自身の公開は root 直下の index.html 行だけに出す (サブディレクトリはディレクトリ行の「共有」で足りる)。
  // ファイル行なのにフォルダ全体が上がるため、押す前に同じフォルダの成果物が対象だと開示する
  if (canShareSessionRoot && depth === 0 && type === "file" && name === SESSION_ROOT_SHARE_ENTRY && !symlink) {
    actions.push({
      kind: "share",
      label: "このフォルダを共有",
      description: "index.html と同じフォルダの成果物を公開",
      descriptionKind: "disclosure",
    });
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
