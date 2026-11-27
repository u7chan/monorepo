import { encodeFilePathParam } from "../lib/fileUrl";
import { publicOrigin } from "../lib/publicOrigin";
import { client, ensureOk, read } from "./http";
import type { FileDownloadCheck, FileListing, FilePreview, FileRename, FileStat, FileUpload, GitInfo } from "../types";

// 並び順と件数上限はサーバーが決めるため、クライアントでは再ソートしない
export const getFiles = (path = ".") => read<FileListing>(client.api.files.$get({ query: { path } }));

/**
 * 単一ファイルの存在確認 (本文は取得しない)。正常ファイルなら 200、404 は不存在、400 は不正・root 外。
 * 502 / 503 はサンドボックス側の失敗で実在の確認には使えない (扱いは classifyFileRefFailure が決める)。
 */
export const statFile = (path: string) => read<FileStat>(client.api.files.stat.$get({ query: { path } }));

/** repo の外・git が無い環境は null。表示側はチップを出さないだけにして、一覧の表示を止めない */
export const getGitInfo = (path = ".") => read<GitInfo>(client.api.files.git.$get({ query: { path } }));

/** 成功は 204 で本文が無い。パスの検証 (root 外 / 不存在 / symlink / ディレクトリ) はサンドボックスに委ねる */
export const deleteFile = async (path: string): Promise<void> => {
  await ensureOk(client.api.files.$delete({ query: { path } }));
};

/** 配下ごと消す `recursive=true` を明示して呼ぶ (空ディレクトリも同じ経路)。検証はサンドボックスに委ねる */
export const deleteDirectory = async (path: string): Promise<void> => {
  await ensureOk(client.api.files.$delete({ query: { path, recursive: "true" } }));
};

/** `name` は 1 セグメントの新しい名前。検証 (root 外 / 形式 / symlink / 同名 409) はサンドボックスに委ねる */
export const renameEntry = (path: string, name: string) =>
  read<FileRename>(client.api.files.rename.$post({ json: { path, name } }));

/**
 * 設定 → ファイル と作業環境（作業フォルダ）のドラッグ＆ドロップ。1 ファイルを raw で送る。
 * 保存名の検証・同名時の連番・上限の最終判定はサンドボックスが行い、一覧の再取得は呼び出し側 (hook) が全件の決着後に 1 回だけ行う。
 */
export const uploadWorkspaceFile = (path: string, file: File, signal?: AbortSignal) =>
  read<FileUpload>(
    fetch(client.api.files.upload.$url({ query: { path, name: file.name } }), {
      method: "POST",
      body: file,
      signal,
    }),
  );

export const getFilePreview = (path: string, signal: AbortSignal) =>
  read<FilePreview>(client.api.files.preview.$get({ query: { path } }, { init: { signal } }));

/**
 * HTML プレビュー (iframe の src)。取得は iframe に任せるので、ここでは URL だけを組み立てる。
 * 同じルートが文書の相対アセット (画像 / `.js` など) も配信するため、path はセグメント単位で encode してパス形式の URL を組み立てる。
 */
export const fileHtmlPreviewUrl = (path: string): string =>
  client.api.files.html[":path{.+}"].$url({ param: { path: encodeFilePathParam(path) } }).toString();

/**
 * ストレージ有効時の HTML プレビュー URL (別オリジンの iframe)。公開オリジン、無ければ health の
 * ポートから組み、どちらも無ければ作らない (dev はアプリと BFF でポートが違うため hostname + port)。
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

/** UI は 400 / 413 の理由をツリーの行に出す (download と同じ走査の見積りを先に取る) */
export const getFileDownloadCheck = (path: string) =>
  read<FileDownloadCheck>(client.api.files.download.check.$get({ query: { path } }));

/**
 * ダウンロードの URL（`<a download>` の href）。保存名は応答の `Content-Disposition` が決める。
 * 本文は fetch せずブラウザに任せる（100 MiB を保持しない）。
 */
export const fileDownloadUrl = (path: string): string => client.api.files.download.$url({ query: { path } }).toString();
