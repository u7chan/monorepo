import { fileRawUrl } from "../../api";
import { attachmentFetchPath, isImageName } from "../../lib/attachments";
import { cn } from "../../lib/cn";

export type AttachedFilesProps = {
  /** 注記の添付パス (絶対パス) */
  files: string[];
  /** ワークスペース root の絶対パス (health.cwd)。raw URL を root 相対へ直すのに使う */
  rootCwd: string;
  compact: boolean;
};

/** 送信済みメッセージの添付。画像はサムネイル、それ以外はファイル名だけを出す。 */
export function AttachedFiles({ files, rootCwd, compact }: AttachedFilesProps) {
  if (files.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap justify-end", compact ? "mb-1 gap-1.5" : "mb-1.5 gap-2")}>
      {files.map((path) => (
        <AttachedFile key={path} path={path} rootCwd={rootCwd} compact={compact} />
      ))}
    </ul>
  );
}

function AttachedFile({ path, rootCwd, compact }: { path: string; rootCwd: string; compact: boolean }) {
  const name = path.split("/").pop() ?? path;
  if (isImageName(name)) {
    return (
      <li>
        <img
          src={fileRawUrl(attachmentFetchPath(rootCwd, path))}
          alt={name}
          title={path}
          className={cn("rounded-lg border border-line object-contain", compact ? "max-h-32" : "max-h-44")}
        />
      </li>
    );
  }
  return (
    <li
      title={path}
      className="flex max-w-60 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-soft px-2 py-1 text-2xs text-ink-soft"
    >
      <span aria-hidden="true" className="shrink-0 text-ink-faint">
        ▤
      </span>
      <span className="min-w-0 truncate">{name}</span>
    </li>
  );
}
