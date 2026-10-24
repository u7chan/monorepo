import { cn } from "../lib/cn";
import type { ActivityServiceView } from "../lib/activityServe";
import { sessionEntryHref } from "../lib/route";
import { ExternalLinkIcon, RunSpinnerIcon, StopIcon } from "./icons";

/**
 * 実行状況の上部に出す「公開中のサービス」1 行。公開枠は全会話で共有の 1 本なので、状態・起動元の会話・
 * 起動コマンド・作業ディレクトリ・待受を 1 行にまとめ、`開く` と `停止` を置く。取得できない間は
 * リンクも操作も出さない (状態を「停止中」へ丸めない)。状態の決定は lib/activityServe を正とする。
 */
export type ActivityServiceRowProps = {
  view: ActivityServiceView;
  /** 停止の確認待ち */
  stopping: boolean;
  /** 直前の操作の失敗理由 */
  error?: string;
  /** モバイルヘッダの帯 (641–900px と singleColumn)。操作のタップ領域を 44px 以上にする */
  compact?: boolean;
  onStop: () => void;
};

/** 状態の形。色だけに頼らず、塗りドット / 薄いドット / ! / スピナーで区別する */
function StateMark({ view }: { view: ActivityServiceView }) {
  switch (view.kind) {
    case "failed":
    case "unknown":
      return (
        <span aria-hidden="true" className="text-1xs leading-none font-bold text-warn-text">
          !
        </span>
      );
    case "starting":
      return <RunSpinnerIcon />;
    case "running":
      return <span aria-hidden="true" className="dot dot-ok" />;
    case "loading":
    case "stopped":
      return <span aria-hidden="true" className="dot dot-idle" />;
  }
}

const NOTE = "text-1xs leading-relaxed text-ink-soft";

export function ActivityServiceRow({ view, stopping, error, compact = false, onStop }: ActivityServiceRowProps) {
  // 操作の accessible name に起動元を含める (行・サービス行に「開く」「停止」が並ぶため)
  const subject = view.owner?.title || (view.launching?.title ?? "") || "起動元不明";
  const openLabel = `「${subject}」のサービスを開く`;
  const stopLabel = `「${subject}」のサービスを停止`;
  return (
    <section aria-label="公開中のサービス" className="grid gap-2 rounded-xl border border-line bg-raised px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-2 min-[641px]:flex-row min-[641px]:items-center min-[641px]:justify-between min-[641px]:gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-1sm font-medium text-ink-strong">
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <StateMark view={view} />
              {view.label}
            </span>
            {view.owner ? (
              <a
                href={sessionEntryHref(view.owner.sessionId, view.owner.spaceId)}
                className="min-w-0 truncate text-accent underline underline-offset-2"
              >
                {view.owner.title || "無題のセッション"}
              </a>
            ) : null}
            {view.launching?.title ? <span className="min-w-0 truncate text-ink">{view.launching.title}</span> : null}
          </p>
          <ServiceDetail view={view} />
        </div>
        {view.url || view.canStop ? (
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
            {view.url ? (
              <a
                href={view.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={openLabel}
                className={cn("btn-quiet border-ok/45 text-ok-text", compact && "min-h-11")}
              >
                <ExternalLinkIcon />
                開く
              </a>
            ) : null}
            {view.canStop ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                aria-label={stopLabel}
                className={cn("btn-quiet border-danger/45 text-danger-text", compact && "min-h-11")}
              >
                <StopIcon />
                {stopping ? "停止を確認中…" : "停止"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {view.kind === "failed" ? <p className={NOTE}>リンクと操作は出しません。状態は自動で取り直します。</p> : null}
      {view.kind === "stopped" ? (
        <p className={NOTE}>公開中のサービスはありません。終了した会話の行から起動できます。</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-1xs break-all text-danger-text">
          サービスの操作に失敗しました: {error}
        </p>
      ) : null}
    </section>
  );
}

function ServiceDetail({ view }: { view: ActivityServiceView }) {
  if (view.kind === "starting") {
    return (
      <p className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", NOTE)}>
        {view.launching?.command ? (
          <code className="font-mono break-all text-ink">{view.launching.command}</code>
        ) : null}
        <span>待受の確認を最大 10 秒待ちます。</span>
      </p>
    );
  }
  if (view.kind === "running" || view.kind === "unknown") {
    return (
      <p className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", NOTE)}>
        {view.command ? <code className="font-mono break-all text-ink">{view.command.command}</code> : null}
        {view.command ? <span className="min-w-0 font-mono break-all">{view.command.cwd || "."}</span> : null}
        <span className="whitespace-nowrap">待受 8080</span>
        {view.kind === "unknown" ? <span>起動元の会話を特定できません</span> : null}
      </p>
    );
  }
  return null;
}
