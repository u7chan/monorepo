import { useCallback, useEffect, useMemo, useState } from "react";
import type { Space } from "server";
import type { Project, SessionSummary } from "../types";
import {
  ACTIVITY_GROUP_ORDER,
  activityCounts,
  activityElapsedLabel,
  activityFinishedLabel,
  activityGroupLabel,
  activityRows,
  activityStatusLabel,
  type ActivityKind,
  type ActivityRow,
} from "../lib/activity";
import { cn } from "../lib/cn";
import { messageFullTimeLabel, messageTimeLabel } from "../lib/messageTime";
import { sessionEntryHref } from "../lib/route";
import type { SessionsFetchSnapshot } from "../lib/sessionsFetch";
import { ArrowLeftIcon, MenuIcon } from "./icons";
import { LoadingMark } from "./LoadingMark";
import { ReloadButton } from "./ReloadButton";

export type ActivityPageProps = {
  /** 全スペースの一覧 (現在スペースで絞らない) */
  sessions: SessionSummary[];
  projects: Project[];
  spaces: Space[];
  /** 一覧の取得状態。初回未取得 / 取得中 / 失敗 / 最終成功時刻を 0 件と区別する */
  fetch: SessionsFetchSnapshot;
  /** 利用者の「再読み込み」。成否を返す (失敗の通知は警告が担う) */
  onReload: () => Promise<boolean>;
  /** 現在選択中の会話 (無ければ新規会話) へ戻る */
  onBack: () => void;
  /** サイドバーが隠れる幅だけ渡す (☰ をヘッダに出す) */
  onOpenNav?: () => void;
  /** モバイルヘッダの帯 (641–900px と singleColumn)。タップ領域を 44px 以上にする */
  compact?: boolean;
};

const GROUP_DOT: Record<ActivityKind, string> = {
  waiting: "dot-warn",
  working: "dot-accent",
  finished: "dot-idle",
};

/**
 * 全スペース横断の実行状況。行の単位は会話 (sessionId) で、進行中 (回答待ち / 処理中) と直近 120 分の
 * 終了を 1 画面に出す。区分・件数・並び・経過時間の文字列は lib/activity を正とする。
 * 経過時間は 1 秒ごとにクライアントで進める (一覧の 4 秒ポーリングとは独立。読み上げの live region にしない)。
 */
export function ActivityPage({
  sessions,
  projects,
  spaces,
  fetch,
  onReload,
  onBack,
  onOpenNav,
  compact = false,
}: ActivityPageProps) {
  const now = useActivityNow();
  const rows = useMemo(() => activityRows(sessions, projects, now), [sessions, projects, now]);
  const counts = useMemo(() => activityCounts(rows), [rows]);
  // 初回成功前は一覧が空でも「0 件」と断定しない (未取得として出す)
  const countsReady = fetch.loaded;
  const groups = ACTIVITY_GROUP_ORDER.map((kind) => ({ kind, rows: rows.filter((row) => row.kind === kind) })).filter(
    (group) => group.rows.length > 0,
  );
  const spaceNames = useMemo(() => new Map(spaces.map((space) => [space.id, space.name])), [spaces]);
  // 利用者の再読み込みの結果だけを通知する (自動更新のたびに読み上げない)
  const [reloadNote, setReloadNote] = useState("");
  const reload = useCallback(() => {
    setReloadNote("");
    void onReload().then((ok) => {
      if (ok) setReloadNote("一覧を更新しました");
    });
  }, [onReload]);
  const reloading = fetch.pending;
  return (
    <section className="activity-view grid h-full min-h-0 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-base">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-5xl min-w-0 items-center gap-2.5 px-4 py-3 sm:px-6">
          {onOpenNav ? (
            <button
              type="button"
              onClick={onOpenNav}
              aria-label="ナビゲーションを開く"
              className={cn("icon-button", compact && "min-h-11 min-w-11")}
            >
              <MenuIcon />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-1xs font-semibold tracking-label text-ink-soft uppercase">Activity</div>
            <h1 className="truncate text-xl font-semibold text-ink-strong">実行状況</h1>
            <div className="truncate text-1xs text-ink-soft">すべてのスペース</div>
          </div>
          <button
            type="button"
            onClick={onBack}
            className={cn("btn-quiet shrink-0 whitespace-nowrap", compact && "min-h-11")}
          >
            <ArrowLeftIcon />
            会話に戻る
          </button>
        </div>
      </header>

      <div className="border-b border-line">
        <div className="mx-auto grid w-full max-w-5xl gap-2 px-4 py-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="inline-flex items-baseline gap-1 text-1xs text-ink-soft">
              <b className="text-xl font-semibold text-ink-strong tabular-nums">
                {countsReady ? counts.inProgress : "—"}
              </b>
              <span>{countsReady ? "件の会話が進行中" : "進行中の会話数は未取得"}</span>
            </span>
            {/* 件数はすべて同じ一覧から数える。初回成功前は 0 と断定せず「—」を出す */}
            <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-1xs text-ink-soft">
              <CountItem tone="dot-accent" label="実行中" value={countsReady ? counts.running : "—"} />
              <CountItem tone="dot-warn" label="回答待ち" value={countsReady ? counts.waiting : "—"} />
              <CountItem tone="dot-idle" label="圧縮中" value={countsReady ? counts.compacting : "—"} />
              <CountItem tone="dot-idle" label="直近の終了" value={countsReady ? counts.finished : "—"} />
            </ul>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            {fetch.lastSuccessAt !== undefined ? (
              <span className="text-1xs text-ink-soft">最終更新 {messageTimeLabel(fetch.lastSuccessAt, { now })}</span>
            ) : null}
            <ReloadButton
              onClick={reload}
              disabled={reloading}
              aria-label="一覧を再読み込み"
              className={cn("shrink-0", compact && "min-h-11")}
            >
              再読み込み
            </ReloadButton>
          </div>
        </div>
      </div>

      <div className="min-h-0 scrollbar-thin overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 pt-3 pb-6 sm:px-6">
          <FetchNote fetch={fetch} reloadNote={reloadNote} />
          {!fetch.loaded ? (
            fetch.failed ? null : (
              <div className="flex items-center gap-2 py-6 text-1xs text-ink-soft">
                <LoadingMark />
                <span>一覧を取得しています…</span>
              </div>
            )
          ) : (
            <>
              {counts.inProgress === 0 ? <p className="py-3 text-1sm text-ink-soft">進行中の会話はありません</p> : null}
              {groups.map((group) => (
                <section key={group.kind} className="mt-3 first:mt-0">
                  <h2 className="flex min-w-0 items-center gap-2 text-1xs font-semibold text-ink-soft">
                    <span className={cn("dot", GROUP_DOT[group.kind])} aria-hidden="true" />
                    <span>{activityGroupLabel(group.kind)}</span>
                    <span className="text-ink tabular-nums">{group.rows.length}</span>
                    <span className="font-normal text-ink-soft">
                      {group.kind === "finished" ? "終了時刻の新しい順" : "最後に使った順"}
                    </span>
                  </h2>
                  <ul className="mt-1.5 grid gap-1.5">
                    {group.rows.map((row) => (
                      <li key={row.sessionId} className="min-w-0">
                        <ActivityRowLink row={row} now={now} spaceName={spaceNames.get(row.spaceId)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {rows.length === 0 ? (
                <p className="py-3 text-1xs text-ink-soft">直近 2 時間に終了した会話もありません</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function CountItem({ tone, label, value }: { tone: string; label: string; value: number | string }) {
  return (
    <li className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn("dot", tone)} aria-hidden="true" />
      <span>{label}</span>
      <b className="font-semibold text-ink tabular-nums">{value}</b>
    </li>
  );
}

function FetchNote({ fetch, reloadNote }: { fetch: SessionsFetchSnapshot; reloadNote: string }) {
  if (fetch.failed) {
    return (
      <p
        role="alert"
        className="mt-1 mb-3 rounded-lg border border-danger/40 bg-raised px-2.5 py-2 text-1xs leading-relaxed text-danger-text"
      >
        {fetch.loaded ? "更新できていません" : "一覧を取得できていません"}
        {fetch.lastSuccessAt !== undefined ? `。最終成功: ${messageFullTimeLabel(fetch.lastSuccessAt)}` : ""}
      </p>
    );
  }
  if (!reloadNote) return null;
  return (
    <p role="status" className="mt-1 mb-3 text-1xs text-ink-soft">
      {reloadNote}
    </p>
  );
}

function ActivityRowLink({ row, now, spaceName }: { row: ActivityRow; now: number; spaceName?: string }) {
  const elapsed = activityElapsedLabel(row, now);
  const finished = activityFinishedLabel(row, now);
  const sinceTitle =
    row.kind === "waiting" ? "回答待ちの開始から" : row.status === "compacting" ? "圧縮開始から" : "実行開始から";
  return (
    // 行全体をリンクにし、タップ・クリックの当たり判定を行にする。accessible name は中の会話タイトルを含む
    <a
      href={sessionEntryHref(row.sessionId, row.spaceId)}
      className="flex min-h-14 min-w-0 flex-col gap-1.5 rounded-xl border border-line bg-raised px-3 py-2.5 transition-colors hover:border-accent/50 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="sr-only">会話を開く: </span>
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
        </span>
      </span>
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
        <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-1xs text-ink-soft">
          <span className="hidden sm:inline">会話を開く</span>
          <span className="sm:hidden">開く</span>
          <span aria-hidden="true">→</span>
        </span>
      </span>
    </a>
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

/** 経過時間用の時計。ページを開いている間だけ 1 秒ごとに進める */
function useActivityNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
