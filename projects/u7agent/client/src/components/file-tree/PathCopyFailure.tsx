import { COPY_FAILED_TEXT } from "../chat/CopyButton";

/**
 * パスコピーの失敗。⋯ は項目の選択で閉じるため、結果はコピー元の面の中の 1 行に残す。
 * 行 (FileBrowser) と作業フォルダ面の帯 (WorkFolderPathMenu) が同じ見せ方を使う。detail は
 * `ClipboardCopyError` の経路の内訳で長い非改行文字列を含むため、flex item の最小幅 (min-w-0) を
 * 外して親幅で折り返し、全文を読めるようにする (行数では切らない)。
 */
export function PathCopyFailure({ detail }: { detail?: string }) {
  if (detail === undefined) return null;
  return (
    <div role="alert" className="min-w-0 basis-full pb-1 pl-2 text-2xs leading-relaxed text-danger-text">
      <span className="block">{COPY_FAILED_TEXT}</span>
      <span className="block break-words text-ink-faint">{detail}</span>
    </div>
  );
}
