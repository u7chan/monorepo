import { fileRawUrl } from "../../api";
import { formatBytes, isImageName, type Attachment } from "../../lib/attachments";
import { cn } from "../../lib/cn";
import { fileTreeFetchPath } from "../../lib/fileTree";
import { CloseIcon } from "../icons";

export type AttachmentChipsProps = {
  attachments: Attachment[];
  /** セッションの作業フォルダ (root 相対)。画像サムネイルの URL を組むのに使う */
  cwd: string;
  /** 非表示 (設定ページ) の間は高さを詰める */
  compact: boolean;
  onRemove: (id: string) => void;
};

/** 選択中 / 送信待ちの添付。画像はサムネイル、それ以外はファイル名とサイズを出す。 */
export function AttachmentChips({ attachments, cwd, compact, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap", compact ? "gap-1.5" : "gap-2")}>
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.id} attachment={attachment} cwd={cwd} onRemove={onRemove} />
      ))}
    </ul>
  );
}

function AttachmentChip({
  attachment,
  cwd,
  onRemove,
}: {
  attachment: Attachment;
  cwd: string;
  onRemove: (id: string) => void;
}) {
  const uploaded = attachment.status === "done" && attachment.path ? attachment.path : undefined;
  const thumbnail = uploaded && isImageName(attachment.name) ? fileRawUrl(fileTreeFetchPath(cwd, uploaded)) : undefined;
  const statusText =
    attachment.status === "uploading"
      ? "アップロード中…"
      : attachment.status === "error"
        ? attachment.error
        : undefined;
  return (
    <li
      className={cn(
        "flex max-w-60 min-w-0 items-center gap-1.5 rounded-lg border px-1.5 py-1 text-2xs",
        attachment.status === "error" ? "border-danger/40 bg-danger/10" : "border-line bg-soft text-ink-soft",
      )}
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" className="size-7 shrink-0 rounded object-cover" />
      ) : (
        <span aria-hidden="true" className="shrink-0 text-ink-faint">
          {attachment.status === "error" ? "!" : "▤"}
        </span>
      )}
      <span className="min-w-0 truncate" title={attachment.name}>
        {attachment.name}
      </span>
      <span className="shrink-0 text-ink-ghost tabular-nums">{formatBytes(attachment.size)}</span>
      {statusText ? <span className="shrink-0 text-danger-text">{statusText}</span> : null}
      <button
        type="button"
        aria-label={`${attachment.name} を外す`}
        onClick={() => onRemove(attachment.id)}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-ink-faint transition-colors hover:bg-hover hover:text-ink"
      >
        <CloseIcon />
      </button>
    </li>
  );
}
