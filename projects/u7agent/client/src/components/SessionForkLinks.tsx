import { cn } from "../lib/cn";
import { FORK_ORIGIN_DELETED_NOTE, type ForkRelations } from "../lib/sessionFork";
import { GitBranchIcon } from "./icons";

/**
 * 分岐元 / 分岐先のリンク。会話の上に 1 行だけ置き、行き来は既存の `/s/<id>` を使う。
 * 分岐元が削除されていても子はそのまま使えるため、リンクを消さずに理由だけを出す。
 */
export function SessionForkLinks({
  relations,
  onOpen,
}: {
  relations: ForkRelations;
  onOpen: (sessionId: string) => void;
}) {
  const origin = relations.origin;
  if (origin === undefined && relations.children.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-6 pb-2 text-1xs text-ink-muted singleColumn:px-3">
      {origin === undefined ? null : (
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-ink-faint">
            <GitBranchIcon />
          </span>
          <span className="shrink-0 text-ink-faint">分岐元:</span>
          {origin === "deleted" ? (
            <span className="min-w-0 truncate text-ink-muted">{FORK_ORIGIN_DELETED_NOTE}</span>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(origin.sessionId)}
              title={origin.title}
              className={cn(
                "min-w-0 truncate text-accent-text underline underline-offset-2",
                "hover:opacity-80 focus-visible:ring-1 focus-visible:ring-focus focus-visible:outline-none",
              )}
            >
              {origin.title}
            </button>
          )}
        </span>
      )}
      {relations.children.length === 0 ? null : (
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-ink-faint">分岐先:</span>
          {relations.children.map((child) => (
            <button
              key={child.sessionId}
              type="button"
              onClick={() => onOpen(child.sessionId)}
              title={child.title}
              className={cn(
                "max-w-64 min-w-0 truncate text-accent-text underline underline-offset-2",
                "hover:opacity-80 focus-visible:ring-1 focus-visible:ring-focus focus-visible:outline-none",
              )}
            >
              {child.title}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
