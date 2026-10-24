import { useCallback, useEffect, useMemo, useState } from "react";
import type { Space } from "server";
import type { Project, SessionSummary } from "../types";
import {
  ACTIVITY_GROUP_ORDER,
  activityCounts,
  activityGroupLabel,
  activityRows,
  type ActivityKind,
  type ActivityRow,
} from "../lib/activity";
import { activityRowServe, activityServiceView, runtimeServeStartConfirm } from "../lib/activityServe";
import { cn } from "../lib/cn";
import { messageFullTimeLabel, messageTimeLabel } from "../lib/messageTime";
import type { SessionsFetchSnapshot } from "../lib/sessionsFetch";
import { useRuntimeServe } from "../hooks/useRuntimeServe";
import { ActivityRowItem } from "./ActivityRowItem";
import { ActivityServiceRow } from "./ActivityServiceRow";
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
  /** health の previewPort (ブラウザから見た公開ポート)。未取得なら「開く」を出さない */
  previewPort?: number;
  /** ブラウザから見たホスト (公開 URL を組む) */
  hostname: string;
};

const GROUP_DOT: Record<ActivityKind, string> = {
  waiting: "dot-warn",
  working: "dot-accent",
  finished: "dot-idle",
};

/**
 * 全スペース横断の実行状況。行の単位は会話 (sessionId) で、進行中 (回答待ち / 処理中) と直近 120 分の
 * 終了を 1 画面に出す。区分・件数・並び・経過時間の文字列は lib/activity、上部のサービス行と行の操作は
 * lib/activityServe を正とする。サービス状態は `/activity` を表示している間だけ 4 秒で回す。
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
  previewPort,
  hostname,
}: ActivityPageProps) {
  const now = useActivityNow();
  const service = useRuntimeServe();
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
  /** 起動の結果の通知。成功したときだけ「開く」へ案内する */
  const [serveNote, setServeNote] = useState("");
  /**
   * 起動に失敗した会話と理由。共有のサービス行ではなく**その行**に出す (別の会話が公開中のときに、
   * どの会話の失敗か分からないまま見えるのを避ける)。一覧を更新したら消す。
   */
  const [startError, setStartError] = useState<{ sessionId: string; message: string } | null>(null);
  const refreshService = service.refresh;
  const reload = useCallback(() => {
    setReloadNote("");
    setStartError(null);
    void onReload().then((ok) => {
      if (ok) setReloadNote("一覧を更新しました");
    });
    // サービス状態は自動でも回るが、取得失敗の案内からも同じ操作で取り直せるようにする
    void refreshService();
  }, [onReload, refreshService]);
  const reloading = fetch.pending;
  // 起動中の対象は一覧から引く (起動の確認待ちの間に対象が一覧から消えたら、会話名は出さない)
  const launchingSession =
    service.starting === null ? undefined : sessions.find((summary) => summary.sessionId === service.starting);
  const launching =
    service.starting === null
      ? undefined
      : {
          ...(launchingSession ? { title: launchingSession.title } : {}),
          ...(launchingSession?.serveCommand ? { command: launchingSession.serveCommand.command } : {}),
        };
  const serviceView = activityServiceView({
    status: service.status,
    failed: service.failed,
    launching,
    hostname,
    port: previewPort,
  });
  const start = (row: ActivityRow) => {
    const status = service.status;
    if (!status || service.failed || !row.serveCommand) return;
    setServeNote("");
    setStartError(null);
    void service.start({ sessionId: row.sessionId, confirm: runtimeServeStartConfirm(row, status) }).then((result) => {
      if (result.kind === "started") {
        setServeNote("サービスを起動しました。「開く」で別タブに開きます");
        return;
      }
      if (result.kind === "failed") setStartError({ sessionId: row.sessionId, message: result.error });
    });
  };
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
          <ActivityServiceRow
            view={serviceView}
            stopping={service.stopping}
            error={service.error}
            compact={compact}
            onStop={() => void service.stop()}
          />
          {serveNote ? (
            <p role="status" className="mt-2 text-1xs text-ink-soft">
              {serveNote}
            </p>
          ) : null}
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
                      <ActivityRowItem
                        key={row.sessionId}
                        row={row}
                        now={now}
                        spaceName={spaceNames.get(row.spaceId)}
                        serve={activityRowServe({
                          row,
                          status: service.status,
                          failed: service.failed,
                          starting: service.starting,
                          hostname,
                          port: previewPort,
                        })}
                        compact={compact}
                        error={startError?.sessionId === row.sessionId ? startError.message : undefined}
                        onStart={start}
                      />
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

/** 経過時間用の時計。ページを開いている間だけ 1 秒ごとに進める */
function useActivityNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
