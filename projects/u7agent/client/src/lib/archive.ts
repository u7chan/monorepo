/**
 * ダウンロード (`<a download>`) の文言と起動。除外名の正はサーバーで、ここは実効値による行の
 * 出し分けと check の応答を使った確認・開始だけを持つ (DOM を触るのは startArchiveDownload だけ)。
 */
import { formatBytes } from "./attachments";
import type { FileDownloadCheck } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

/** 除外規則で落とされる名前の行には導線を出さない（クリック後の 400 を事前に避ける） */
export function isArchiveExcludedName(name: string, excludeNames: readonly string[]): boolean {
  return excludeNames.includes(name);
}

/**
 * ディレクトリの確認ダイアログ。除外があるときだけ 1 回出し、件数は ZIP のエントリ数、フォルダ名は
 * clamp した独立した行へ (本文は件数と除外名だけにする)。
 */
export function archiveConfirmRequest(name: string, check: FileDownloadCheck): ConfirmRequest {
  return {
    kind: "confirm",
    title: "ZIP でダウンロード",
    subject: { label: "ダウンロードするフォルダ", value: name },
    body: [
      `含まれるファイル数 ${check.entries} 件 / 合計サイズ ${formatBytes(check.bytes)}`,
      `除外: ${check.skipped.join(", ")}`,
    ],
    confirmLabel: "ダウンロードする",
  };
}

/**
 * `<a download>` をプログラム的にクリックして保存を始める。本文は fetch せずブラウザに任せるので
 * メモリに載らず遷移もしない。Firefox は未接続要素の click を無視するため押す間だけ append する。
 */
export function startArchiveDownload(url: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
