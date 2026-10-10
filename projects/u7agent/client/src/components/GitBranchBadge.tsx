import { GitBranchIcon } from "./icons";

/**
 * 作業フォルダが属する repo のブランチ (root の行)。repo の外では呼び出し側が描かない。
 * 長いブランチ名は `max-w-40` で切り詰め、全文は `title` で読めるようにする。幅は `shrink-0` で守り、
 * パスと 1 段に並べられない面では呼び出し側の行が次の段へ落とす (縮めて並べない)。
 */
export function GitBranchBadge({ branch }: { branch: string }) {
  return (
    <span
      title={`git ブランチ: ${branch}`}
      className="inline-flex max-w-40 min-w-0 shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-2xs text-ink-muted"
    >
      <GitBranchIcon />
      <span className="truncate">{branch}</span>
    </span>
  );
}
