import { cn } from "../lib/cn";
import { ActivityIcon } from "./icons";

/**
 * 実行状況 ( `/activity` ) の入口。サイドバーとバー (サイドバーが隠れる幅) で同じ値を使う。
 * 件数は全スペースの進行中で、未取得 (一度も成功していない) は数字を出さず、取得に失敗している間は
 * 前回の値であることを示す (0 件と誤表示しない)。
 */
export type ActivityEntryProps = {
  /** 実行状況を表示中か ( `aria-current="page"` ) */
  active: boolean;
  /** 全スペースの進行中件数。未取得は undefined */
  count?: number;
  /** 直近の一覧取得が失敗している (件数は前回の値) */
  stale?: boolean;
  onOpen: () => void;
};

function entryLabel({ count, stale }: Pick<ActivityEntryProps, "count" | "stale">): string {
  if (count === undefined) return "実行状況（全スペース・件数は未取得）";
  return `実行状況（全スペースの進行中 ${count} 件${stale ? "・更新できていません" : ""}）`;
}

/** サイドバーの nav モードの入口。「すべてのスペース」をサブテキストで明示する */
export function ActivityEntry({ active, count, stale, onOpen }: ActivityEntryProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      aria-label={entryLabel({ count, stale })}
      title={entryLabel({ count, stale })}
      className={cn(
        "flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors singleColumn:min-h-11",
        active
          ? "border-accent/50 bg-accent-wash text-accent-text"
          : "border-line bg-raised text-ink hover:border-accent/50 hover:text-accent-text",
      )}
    >
      <span className="shrink-0">
        <ActivityIcon />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-xs font-medium">実行状況</span>
        <span className="truncate text-1xs text-ink-soft">すべてのスペース</span>
      </span>
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-1xs text-ink-soft tabular-nums"
      >
        {stale ? <span className="text-warn">!</span> : null}
        {count ?? "—"}
      </span>
    </button>
  );
}

/**
 * バー (Topbar / SingleColumnBar) の入口。サイドバーを開かずに到達できるようにする。
 * `label` を渡すと「実行状況」の文字も出す (desktop のバー)。狭い singleColumn は数字だけにする。
 */
export function ActivityEntryButton({
  active,
  count,
  stale,
  onOpen,
  label = false,
}: ActivityEntryProps & { label?: boolean }) {
  const text = entryLabel({ count, stale });
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      aria-label={text}
      title={text}
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-1xs transition-colors singleColumn:min-h-11",
        active
          ? "border-accent/50 text-accent-text"
          : "border-line text-ink-soft hover:border-accent/50 hover:text-accent-text",
      )}
    >
      <ActivityIcon />
      {label ? <span className="whitespace-nowrap">実行状況</span> : null}
      <span className="inline-flex items-center gap-0.5 tabular-nums" aria-hidden="true">
        {stale ? <span className="text-warn">!</span> : null}
        {count ?? "—"}
      </span>
    </button>
  );
}
