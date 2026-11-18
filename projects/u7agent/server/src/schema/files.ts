/** ファイルツリー / プレビュー / アップロード / ダウンロードの DTO。DTO のフィールド名と optional の扱いは client と揃える。 */
import { z } from "zod";

/**
 * 作業領域の一覧 (サンドボックス GET /v1/files の応答をそのまま返す)。
 * ワイヤ契約の正は server/src/sandbox/protocol.ts で、ここは BFF が受けた応答の検証用。
 */
export const FileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  /** lstat が symlink のとき true。type は辿った先の実体の種別 */
  symlink: z.boolean().optional(),
  /** stat できたファイルだけ (ディレクトリには付かない) */
  size: z.number().optional(),
  /** epoch ms。stat できたエントリに付き、壊れた symlink には付かない */
  mtime: z.number().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;
export const FileListingSchema = z.object({
  /** root 相対の正規化パス (root は ".") */
  path: z.string(),
  entries: z.array(FileEntrySchema),
  truncated: z.boolean(),
});
export type FileListing = z.infer<typeof FileListingSchema>;
/**
 * 単一ファイルの存在確認 (BFF GET /api/files/stat とサンドボックス GET /v1/files/stat の応答)。
 * path は実在を確認できた通常ファイルの root 相対の正規化パス (root は ".")。本文は含まない。
 */
export const FileStatSchema = z.object({ path: z.string() });
export type FileStat = z.infer<typeof FileStatSchema>;
/**
 * git 情報 (サンドボックス GET /v1/files/git の応答)。branch は HEAD のブランチ名で、detached HEAD は
 * 短縮 SHA。repo の外・git が無い環境は null で、UI はチップを出さないだけにする。
 */
export const GitInfoSchema = z.object({ branch: z.string().nullable() });
export type GitInfo = z.infer<typeof GitInfoSchema>;
/**
 * テキストプレビュー (サンドボックス GET /v1/files/preview の応答)。
 * サンドボックス側の上限はバイト数で、ここは UTF-16 単位の防御。UTF-8 ではバイト数 ≥ 単位数なので通った文字列を弾かない。
 * 値は SANDBOX_MAX_PREVIEW_BYTES と揃える (変更手順は docs/file-preview.md の「上限」を参照)。
 */
export const FilePreviewSchema = z.object({ text: z.string().max(2 * 1024 * 1024) });
export type FilePreview = z.infer<typeof FilePreviewSchema>;
/**
 * アップロード応答 (サンドボックス POST /v1/files/upload の応答をそのまま返す)。
 * path はセッションの作業フォルダ相対で、raw 表示 URL はクライアントが root 相対へ変換する。
 */
export const FileUploadSchema = z.object({
  path: z.string(),
  name: z.string(),
  renamed: z.boolean(),
  size: z.number(),
});
export type FileUpload = z.infer<typeof FileUploadSchema>;
/**
 * リネーム (POST /api/files/rename) のリクエストボディ。path は root 相対のエントリ、name は 1 セグメントの新しい名前。
 * 名前の形式 (空・`.`・`..`・`/` など) とパスの検証はサンドボックスが行う。
 */
export const RenameFileBodySchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type RenameFileBody = z.infer<typeof RenameFileBodySchema>;
/**
 * リネーム応答 (サンドボックス POST /v1/files/rename の応答をそのまま返す)。
 * path は改名後のエントリのワークスペース root 相対パス。
 */
export const FileRenameSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type FileRename = z.infer<typeof FileRenameSchema>;
/**
 * ダウンロードの事前チェック (BFF GET /api/files/download/check とサンドボックス GET /v1/files/download/check の応答)。
 * ワイヤ契約の正は server/src/sandbox/protocol.ts の `SandboxDownloadCheck`。
 */
export const FileDownloadCheckSchema = z.object({
  kind: z.enum(["file", "archive"]),
  /** 保存名。ファイルはその名前、ZIP は `<フォルダ名>.zip` */
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  /** 除外規則で落とした名前 (重複なし) */
  skipped: z.array(z.string()),
});
export type FileDownloadCheck = z.infer<typeof FileDownloadCheckSchema>;
