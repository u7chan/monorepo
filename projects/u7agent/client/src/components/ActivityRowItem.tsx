import { cn } from "../lib/cn";
import type { ReactNode } from "react";
import {
  activityElapsedLabel,
  activityFinishedLabel,
  activityStatusLabel,
  type ActivityKind,
  type ActivityRow,
} from "../lib/activity";
import type { ActivityRowServe } from "../lib/activityServe";
import { sessionEntryHref } from "../lib/route";
import { ExternalLinkIcon } from "./icons";

/**
 * 実行状況の 1 行。操作を持たない行は行全体が会話のリンク (タップ領域を行にする)。
 * `起動` / `開く` を持つ行だけ「タイトル + メタのリンク」と「状態ピル + 操作」に分ける
 * (リンクの中に button を入れ子にしない)。操作の有無は lib/activityServe が決める。
 */
export type ActivityRowItemProps = {
  row: ActivityRow;
  now: number;
  spaceName?: string;
  serve: ActivityRowServe;
  /** モバイルヘッダの帯 (641–900px と singleColumn)。操作のタップ領域を 44px 以上にする */
  compact?: boolean;
  /** この行の起動に失敗した理由。どの会話の失敗かは行だけが知っているので、行の中に出す */
  error?: string;
  onStart: (row: ActivityRow) => void;
};

const ROW_BASE =
  "flex min-h-14 min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-raised px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3";
const ROW_FRAME = "grid min-w-0 gap-1.5 rounded-xl border border-line bg-raised px-3 py-2.5";

const GROUP_DOT: Record<ActivityKind, string> = {
  waiting: "dot-warn",
  working: "dot-accent",
  finished: "dot-idle",
};

export function ActivityRowItem({ row, now, spaceName, serve, compact = false, error, onStart }: ActivityRowItemProps) {
  const body = <RowBody row={row} now={now} spaceName={spaceName} served={serve.served} />;
  if (serve.action === "none") {
    return (
      <li className="min-w-0">
        {/* 行全体をリンクにし、タップ・クリックの当たり判定を行にする。accessible name は中の会話タイトルを含む */}
        <a
          href={sessionEntryHref(row.sessionId, row.spaceId)}
          className={cn(
            ROW_BASE,
            "transition-colors hover:border-accent/50 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
          )}
        >
          <span className="sr-only">会話を開く: </span>
          {body}
          <RowSide row={row}>
            <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-1xs text-ink-soft">
              <span className="hidden sm:inline">会話を開く</span>
              <span className="sm:hidden">開く</span>
              <span aria-hidden="true">→</span>
            </span>
          </RowSide>
        </a>
      </li>
    );
  }
  return (
    <li className="min-w-0">
      <div className={ROW_FRAME}>
        <div className="flex min-h-14 min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <a
            href={sessionEntryHref(row.sessionId, row.spaceId)}
            className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            <span className="sr-only">会話を開く: </span>
            {body}
          </a>
          <RowSide row={row}>
            <RowAction row={row} serve={serve} compact={compact} onStart={onStart} />
          </RowSide>
        </div>
        {error ? (
          <p role="alert" className="text-1xs break-all text-danger-text">
            サービスの起動に失敗しました: {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function RowBody({
  row,
  now,
  spaceName,
  served,
}: {
  row: ActivityRow;
  now: number;
  spaceName?: string;
  served: boolean;
}) {
  const elapsed = activityElapsedLabel(row, now);
  const finished = activityFinishedLabel(row, now);
  const sinceTitle =
    row.kind === "waiting" ? "回答待ちの開始から" : row.status === "compacting" ? "圧縮開始から" : "実行開始から";
  return (
    <span className="grid min-w-0 flex-1 gap-1">
      <span className="min-w-0 text-1sm font-medium break-words text-ink-strong sm:truncate">{row.title}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-1xs text-ink-soft">
        <span className="inline-flex max-w-full min-w-0 items-center rounded-full border border-line px-1.5 text-1xs text-ink-soft">
          <span className="min-w-0 truncate">{spaceName ?? "不明なスペース"}</span>
        </span>
        <span className="min-w-0 truncate">{row.agentName}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate">{row.projectLabel}</span>
        {elapsed !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            {/* 毎秒変わる数字は読み上げの live region にしない (視覚更新だけ) */}
            <span className="min-w-12 shrink-0 tabular-nums" title={sinceTitle}>
              {elapsed}
            </span>
          </>
        ) : null}
        {finished !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">{finished}</span>
          </>
        ) : null}
        {served ? (
          <span
            title="この会話のサービスが公開中"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ok/45 px-1.5 text-1xs text-ok-text"
          >
            <span aria-hidden="true" className="dot dot-ok" />
            稼働中
          </span>
        ) : null}
      </span>
    </span>
  );
}

function RowSide({ row, children }: { row: ActivityRow; children: ReactNode }) {
  return (
    <span className="flex min-w-0 shrink-0 items-center justify-between gap-2 sm:justify-end">
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-1xs",
          statusTone(row),
        )}
      >
        <span className={cn("dot", GROUP_DOT[row.kind])} aria-hidden="true" />
        {activityStatusLabel(row)}
      </span>
      {children}
    </span>
  );
}

function RowAction({
  row,
  serve,
  compact,
  onStart,
}: {
  row: ActivityRow;
  serve: ActivityRowServe;
  compact: boolean;
  onStart: (row: ActivityRow) => void;
}) {
  if (serve.action === "starting") {
    return <span className="text-1xs whitespace-nowrap text-ink-soft">起動中…</span>;
  }
  if (serve.action === "open") {
    return (
      <a
        href={serve.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`「${row.title}」のサービスを開く`}
        className={cn("btn-quiet border-ok/45 text-ok-text", compact && "min-h-11")}
      >
        <ExternalLinkIcon />
        開く
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onStart(row)}
      disabled={serve.disabled}
      aria-label={`「${row.title}」のサービスを起動`}
      title={serve.command ? `起動: ${serve.command.cwd || "."} / ${serve.command.command}` : undefined}
      className={cn("btn-quiet border-accent/45 text-accent-text", compact && "min-h-11")}
    >
      起動
    </button>
  );
}

function statusTone(row: ActivityRow): string {
  if (row.kind === "waiting") return "border-warn/45 text-warn-text";
  if (row.kind === "working") {
    return row.status === "compacting" ? "border-line text-ink-soft" : "border-accent/45 text-accent-text";
  }
  if (row.status === "error") return "border-danger/45 text-danger-text";
  if (row.status === "stopped") return "border-line text-ink-soft";
  return "border-ok/45 text-ok-text";
}
