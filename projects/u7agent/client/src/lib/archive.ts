/**
 * ファイル / フォルダのダウンロード（`<a download>`）の文言と起動。除外名の正はサーバーで、
 * ここは渡された実効値（設定ストア）による行の出し分けと、check の応答を使った確認・開始だけを持つ。
 * 判定と文言を純関数に閉じ、DOM を触るのは `startArchiveDownload` だけにする。
 */
import { formatBytes } from "./attachments";
import type { FileDownloadCheck } from "../types";

/** 除外規則で落とされる名前の行には導線を出さない（クリック後の 400 を事前に避ける） */
export function isArchiveExcludedName(name: string, excludeNames: readonly string[]): boolean {
  return excludeNames.includes(name);
}

/**
 * ディレクトリの確認ダイアログ。除外があるときだけ 1 回出す（何が入らないかを開始前に示す）。
 * 件数は ZIP のエントリ数で、サイズは確認ダイアログ用の丸めた表記にする。
 */
export function archiveConfirmMessage(name: string, check: FileDownloadCheck): string {
  return [
    `「${name}」を ZIP でダウンロードします。`,
    `含まれるファイル数 ${check.entries} 件 / 合計サイズ ${formatBytes(check.bytes)}`,
    `除外: ${check.skipped.join(", ")}`,
  ].join("\n");
}

/**
 * `<a download>` をプログラム的にクリックして保存を始める。本文は fetch せずブラウザの保存に任せるため、
 * 100 MiB をメモリに載せず、ページ遷移も起きない（ツリーとチャットの状態はそのまま）。
 * Firefox は document に繋がっていない要素の click を無視するため、押す間だけ append する。
 */
export function startArchiveDownload(url: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
