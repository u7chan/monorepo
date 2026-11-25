import { encodeFilePathParam } from "../lib/fileUrl";
import { publicOrigin } from "../lib/publicOrigin";
import { apiError, client } from "./http";
import type { FileDownloadCheck, FileListing, FilePreview, FileRename, FileStat, FileUpload, GitInfo } from "../types";

// 並び順と件数上限はサーバーが決めるため、クライアントでは再ソートしない
export const getFiles = async (path = "."): Promise<FileListing> => {
  const res = await client.api.files.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  // 400 (root 外) / 503 (未設定) の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FileListing;
};

/**
 * 単一ファイルの存在確認（本文は取得しない）。通常ファイルとして実在するときだけ 200 で、404 は不存在、
 * 400 は不正・root 外・通常ファイル以外。502 / 503 はサンドボックス側の失敗で、**実在の確認には使えない**
 * （不存在と混同しない扱いは呼び出し側の `classifyFileRefFailure` が決める）。
 */
export const statFile = async (path: string): Promise<FileStat> => {
  const res = await client.api.files.stat.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as FileStat;
};

/**
 * 作業フォルダ (root 相対) が属する repo のブランチ。repo の外・git が無い環境は null で、
 * 表示側はチップを出さないだけにする (一覧の表示を止めない)。
 */
export const getGitInfo = async (path = "."): Promise<GitInfo> => {
  const res = await client.api.files.git.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as GitInfo;
};

/**
 * ファイルの削除。成功は 204 で本文が無いため JSON は読まない。パスは GET /api/files と同じ root 相対で、
 * 検証 (root 外 / 不存在 / symlink / ディレクトリ) はサンドボックスに委ねる。
 */
export const deleteFile = async (path: string): Promise<void> => {
  const res = await client.api.files.$delete({ query: { path } });
  if (!res.ok) throw await apiError(res);
};

/**
 * ディレクトリの削除。配下ごと消す `recursive=true` を明示して呼ぶ (空ディレクトリも同じ経路)。
 * 成功は 204 で本文が無いため JSON は読まない。検証 (root 外 / 不存在 / ディレクトリ以外 / symlink) はサンドボックスに委ねる。
 */
export const deleteDirectory = async (path: string): Promise<void> => {
  const res = await client.api.files.$delete({ query: { path, recursive: "true" } });
  if (!res.ok) throw await apiError(res);
};

/**
 * エントリ (ファイル / ディレクトリ) のリネーム。`path` は GET /api/files と同じ root 相対で、`name` は 1 セグメントの新しい名前。
 * 検証 (root 外 / 不存在 / 形式 / symlink / 同名 409) はサンドボックスに委ね、応答は改名後の root 相対パス。
 */
export const renameEntry = async (path: string, name: string): Promise<FileRename> => {
  const res = await client.api.files.rename.$post({ json: { path, name } });
  if (!res.ok) throw await apiError(res);
  // 400 / 404 / 409 / 503 の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FileRename;
};

/**
 * 設定 → ファイル と作業環境（作業フォルダ）のドラッグ＆ドロップ。raw の本文で 1 ファイルを送り、保存先 (`path`。"" は root) と
 * 名前は query で渡す。保存名の検証・同名時の連番・上限の最終判定はサンドボックスが行う。
 * 一覧の再取得は呼び出し側 (hook) が全件の決着後に 1 回だけ行う。
 */
export const uploadWorkspaceFile = async (path: string, file: File, signal?: AbortSignal): Promise<FileUpload> => {
  const res = await fetch(client.api.files.upload.$url({ query: { path, name: file.name } }), {
    method: "POST",
    body: file,
    signal,
  });
  if (!res.ok) throw await apiError(res);
  // 400 (名前 / root 外) / 413 / 502 / 503 の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FileUpload;
};

export const getFilePreview = async (path: string, signal: AbortSignal): Promise<FilePreview> => {
  const res = await client.api.files.preview.$get({ query: { path } }, { init: { signal } });
  if (!res.ok) throw await apiError(res);
  // 400 (root 外 / バイナリ等) / 503 (未設定) の応答型が残るため、!ok を throw で切った後に DTO 型へ寄せる
  return (await res.json()) as FilePreview;
};

/**
 * HTML プレビュー (iframe の src)。取得は iframe に任せるので、ここでは URL だけを組み立てる。
 * 同じルートが文書の相対アセット (画像 / `.js` など) も配信するため、path はセグメント単位で encode してパス形式の URL を組み立てる。
 */
export const fileHtmlPreviewUrl = (path: string): string =>
  client.api.files.html[":path{.+}"].$url({ param: { path: encodeFilePathParam(path) } }).toString();

/**
 * ストレージ有効モードの HTML プレビュー URL (別オリジンの iframe の src)。公開オリジン (health の
 * filePreviewOrigin) を優先し、無ければ health のポートから組む (client にポートを焼き込まない)。
 * location.host ではなく hostname + port を組むのは、dev でアプリが Vite の 3000 に居り BFF が別ポートのため
 * (相対ルートはアプリ オリジンに解決されてしまう)。どちらも無ければ URL を作らない。
 */
export const fileStoragePreviewUrl = (path: string, target: { origin?: string; port?: number }): string | undefined => {
  const relative = `/api/files/html/${encodeFilePathParam(path)}`;
  const origin = publicOrigin(target.origin);
  if (origin !== undefined) return `${origin}${relative}`;
  if (target.port === undefined) return undefined;
  return `http://${location.hostname}:${target.port}${relative}`;
};

/**
 * 画像プレビュー用の raw URL。path はワークスペース root 相対で、配信できるのは allowlist の画像だけ。
 * 生配信に載せるため bodyGuard の上限を通らず、Content-Type はサーバーが決める。
 */
export const fileRawUrl = (path: string, version?: number): string => {
  const url = client.api.files.raw.$url({ query: { path } });
  if (version !== undefined) url.searchParams.set("v", String(version));
  return url.toString();
};

/**
 * ダウンロードの事前チェック。download と同じ走査の見積り（種別 / 保存名 / 除外名 / 合計サイズ / 件数）を返し、
 * 除外名のディレクトリ・上限超過は 400 / 413 で reject する（UI はツリーの行に理由を出す）。
 */
export const getFileDownloadCheck = async (path: string): Promise<FileDownloadCheck> => {
  const res = await client.api.files.download.check.$get({ query: { path } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as FileDownloadCheck;
};

/**
 * ダウンロードの URL（`<a download>` の href）。ファイルは生配信、ディレクトリは ZIP になり、
 * 保存名は応答の `Content-Disposition` が決める。本文は fetch せずブラウザに任せる（100 MiB を保持しない）。
 */
export const fileDownloadUrl = (path: string): string => client.api.files.download.$url({ query: { path } }).toString();
