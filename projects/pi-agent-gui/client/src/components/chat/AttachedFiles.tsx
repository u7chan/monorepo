import { fileRawUrl } from "../../api";
import { isImageName } from "../../lib/attachments";
import { cn } from "../../lib/cn";
import { fileTreeFetchPath } from "../../lib/fileTree";

export type AttachedFilesProps = {
  /** 作業フォルダ相対のパス (uploads/…) */
  files: string[];
  /** セッションの作業フォルダ (root 相対) */
  cwd: string;
  compact: boolean;
};

/** 送信済みメッセージの添付。画像はサムネイル、それ以外はファイル名だけを出す。 */
export function AttachedFiles({ files, cwd, compact }: AttachedFilesProps) {
  if (files.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap justify-end", compact ? "mb-1 gap-1.5" : "mb-1.5 gap-2")}>
      {files.map((path) => (
        <AttachedFile key={path} path={path} cwd={cwd} compact={compact} />
      ))}
    </ul>
  );
}

function AttachedFile({ path, cwd, compact }: { path: string; cwd: string; compact: boolean }) {
  const name = path.split("/").pop() ?? path;
  if (isImageName(name)) {
    return (
      <li>
        <img
          src={fileRawUrl(fileTreeFetchPath(cwd, path))}
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
