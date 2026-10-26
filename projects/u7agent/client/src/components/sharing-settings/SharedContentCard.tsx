import { Fragment, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { fileTimeLabel, messageFullTimeLabel } from "../../lib/messageTime";
import { sessionEntryHref } from "../../lib/route";
import {
  type SharedContentAction,
  type SharedContentBusyKind,
  type SharedContentMenuKind,
  sharedContentActions,
  sharedContentBusyLabel,
  sharedContentMenuActions,
  sharedContentPrimaryAction,
  sharedContentSourceLabel,
  SHARED_CONTENT_SESSION_DELETED_LABEL,
  isSharedContentUndeployed,
  shareStatusView,
  type ShareStatusTone,
} from "../../lib/sharedContents";
import type { SessionSummary, SharedContentResponse } from "../../types";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  PencilIcon,
  PowerIcon,
  RefreshIcon,
  RunSpinnerIcon,
  StopIcon,
  TrashIcon,
  WarningIcon,
} from "../icons";
import { SharedContentMenu } from "./SharedContentMenu";

export type SharedContentCardProps = {
  item: SharedContentResponse;
  /** 600px 未満。操作を主操作 + ⋯ に畳み、meta を絞る */
  narrow: boolean;
  /** セッションが削除済み。更新だけを無効にする */
  sessionMissing: boolean;
  /** 公開元の会話。会話一覧が信頼できて見つかったときだけ渡す（無い = リンクを出さない） */
  session: SessionSummary | undefined;
  /** 会話リンクの通常クリック。修飾キー付きはブラウザ既定（新規タブ）に任せる */
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
  /** この共有物の操作中。操作を止めて、何をしているかを出す */
  busy: { kind: SharedContentBusyKind } | null;
  /** この共有物の直前の操作失敗（BFF の固定文言） */
  error: string | undefined;
  copied: boolean;
  copyFailure: string | undefined;
  onCopy: (url: string, id: string) => void;
  onRename: () => void;
  onUpdate: () => void;
  onStop: () => void;
  onResume: () => void;
  onRetry: () => void;
  onDelete: () => void;
};

function ActionIcon({ kind }: { kind: SharedContentAction["kind"] }) {
  switch (kind) {
    case "open":
      return <ExternalLinkIcon />;
    case "rename":
      return <PencilIcon />;
    case "update":
    case "retry":
      return <RefreshIcon />;
    case "stop":
      return <StopIcon />;
    case "resume":
      return <PowerIcon />;
    case "delete":
      return <TrashIcon />;
  }
}

const TONE_CLASS: Record<ShareStatusTone, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok-text",
  warn: "border-warn/40 bg-warn/10 text-warn-text",
  danger: "border-danger/40 bg-danger/10 text-danger-text",
  busy: "border-line-strong bg-raised text-ink-soft",
};

/** 状態の印。色だけに頼らず、処理中はスピナー、それ以外は点を添える */
function StatusBadge({ label, tone }: { label: string; tone: ShareStatusTone }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      {tone === "busy" ? <RunSpinnerIcon /> : <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}

function actionToneClass(action: SharedContentAction): string {
  return action.danger === true
    ? "border-danger/45 text-danger-text hover:bg-danger/10"
    : "hover:border-accent/50 hover:text-accent-text";
}

/** meta の 1 項目。項目名は淡色、値は本文色にする（・で区切って 1 行に並べる） */
function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <b className="font-medium text-ink-faint">{label}</b>
      {children}
    </span>
  );
}

export function SharedContentCard({
  item,
  narrow,
  sessionMissing,
  session,
  onOpenSession,
  busy,
  error,
  copied,
  copyFailure,
  onCopy,
  onRename,
  onUpdate,
  onStop,
  onResume,
  onRetry,
  onDelete,
}: SharedContentCardProps) {
  const view = shareStatusView(item);
  const handlers: Record<SharedContentMenuKind, () => void> = {
    rename: onRename,
    update: onUpdate,
    stop: onStop,
    delete: onDelete,
  };
  const runAction = (action: SharedContentAction) => {
    switch (action.kind) {
      case "rename":
        onRename();
        return;
      case "update":
        onUpdate();
        return;
      case "stop":
        onStop();
        return;
      case "resume":
        onResume();
        return;
      case "retry":
        onRetry();
        return;
      case "delete":
        onDelete();
        return;
      case "open":
        return;
    }
  };

  const rowActions = sharedContentActions(item, { sessionMissing });
  const menuActions = sharedContentMenuActions(item, { sessionMissing, narrow });
  const primary = sharedContentPrimaryAction(item, { sessionMissing });
  const undeployed = isSharedContentUndeployed(item);
  // 停止中も URL は見せる契約だが、開く・コピーは出さない（未デプロイは URL 自体を出さない）
  const showUrl = item.publicUrl !== null && item.status !== "publishing" && !undeployed;
  const copyable = showUrl && view.openUrl !== null;

  // 狭い面では「更新」を出さず、公開元と 1 つの時刻だけにする（停止中は停止時刻）
  const time =
    item.status === "publishing"
      ? { label: "受付", at: item.createdAt }
      : narrow && item.status === "stopped"
        ? { label: "停止", at: item.stoppedAt ?? item.updatedAt }
        : { label: "更新", at: item.updatedAt };

  const meta: { key: string; node: ReactNode }[] = [
    {
      key: "source",
      node: (
        <MetaItem label="公開元">
          <code className="min-w-0 font-mono break-all text-ink-soft">{sharedContentSourceLabel(item)}</code>
        </MetaItem>
      ),
    },
    ...(session === undefined
      ? []
      : [
          {
            key: "session",
            node: (
              <MetaItem label="会話">
                <a
                  href={sessionEntryHref(session.sessionId, session.spaceId)}
                  onClick={(event) => {
                    if (
                      !onOpenSession ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    onOpenSession(session.sessionId, session.spaceId);
                  }}
                  className="min-w-0 break-words text-accent underline underline-offset-2"
                >
                  {session.title || "無題のセッション"}
                </a>
              </MetaItem>
            ),
          },
        ]),
    {
      key: "time",
      node: (
        <MetaItem label={time.label}>
          <time
            dateTime={new Date(time.at).toISOString()}
            title={messageFullTimeLabel(time.at)}
            className="tabular-nums"
          >
            {fileTimeLabel(time.at)}
          </time>
        </MetaItem>
      ),
    },
  ];
  if (!narrow && item.publishedAt !== null) {
    meta.push({
      key: "published",
      node: (
        <MetaItem label="公開">
          <time
            dateTime={new Date(item.publishedAt).toISOString()}
            title={messageFullTimeLabel(item.publishedAt)}
            className="tabular-nums"
          >
            {fileTimeLabel(item.publishedAt)}
          </time>
        </MetaItem>
      ),
    });
  }
  if (!narrow && item.stoppedAt !== null) {
    meta.push({
      key: "stopped",
      node: (
        <MetaItem label="停止">
          <time
            dateTime={new Date(item.stoppedAt).toISOString()}
            title={messageFullTimeLabel(item.stoppedAt)}
            className="tabular-nums"
          >
            {fileTimeLabel(item.stoppedAt)}
          </time>
        </MetaItem>
      ),
    });
  }

  const hints: string[] = [];
  if (item.status === "publishing" && item.lastError === null) {
    hints.push("完了すると URL と操作が表示されます。");
  }
  if (item.status === "publishing" && item.lastError !== null) {
    hints.push("状態が確定するまで停止だけできます。");
  }
  if (sessionMissing) {
    hints.push("セッションが削除済みのため、更新だけ利用できません。");
  }

  return (
    <article
      aria-busy={busy !== null}
      className={cn(
        "grid min-w-0 gap-2 rounded-lg border bg-soft p-3",
        busy === null ? "border-line" : "border-accent/35",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {/* 長い表示名でも操作行を押し下げすぎないよう 2 行で切る（全文は title で読める） */}
          <h3 title={item.name} className="line-clamp-2 min-w-0 text-1sm font-semibold break-words text-ink-strong">
            {item.name}
          </h3>
          <StatusBadge
            label={busy === null ? view.label : sharedContentBusyLabel(busy.kind)}
            tone={busy === null ? view.tone : "busy"}
          />
          {sessionMissing ? (
            <span className="shrink-0 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-2xs text-ink-faint">
              {SHARED_CONTENT_SESSION_DELETED_LABEL}
            </span>
          ) : null}
        </div>
        {/* ⋯ は幅を問わず右上へ固定する。名前の長さで位置が動かず、行の主操作の幅も変わらない */}
        {menuActions.length === 0 ? null : (
          <SharedContentMenu name={item.name} actions={menuActions} onSelect={(kind) => handlers[kind]()} />
        )}
      </div>

      {showUrl ? (
        copyable ? (
          <div className="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-raised py-0.5 pr-0.5 pl-2.5">
            <code className="min-w-0 flex-1 font-mono text-2xs break-all text-ink-soft select-all">
              {item.publicUrl}
            </code>
            <button
              type="button"
              onClick={() => onCopy(item.publicUrl ?? "", item.id)}
              aria-label={copied ? "URL をコピーしました" : "URL をコピー"}
              title={copied ? "URL をコピーしました" : "URL をコピー"}
              className={cn(
                "grid shrink-0 place-items-center rounded-md transition-colors",
                narrow ? "size-10" : "size-7",
                copied ? "text-ok" : "text-ink-faint hover:bg-hover hover:text-accent-text",
              )}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
        ) : (
          // 停止中は URL を記録として残すが、開く・コピーは出さない（押しても 404 になる）
          <code className="min-w-0 font-mono text-2xs break-all text-ink-faint select-all">{item.publicUrl}</code>
        )
      ) : null}
      {item.status === "publishing" ? (
        <p className="text-2xs text-ink-muted">公開が完了すると URL を表示します</p>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-2xs text-ink-muted">
        {meta.map((entry, index) => (
          <Fragment key={entry.key}>
            {index === 0 ? null : (
              <span aria-hidden="true" className="text-ink-ghost">
                ・
              </span>
            )}
            {entry.node}
          </Fragment>
        ))}
      </div>

      {view.note === null ? null : (
        <p
          className={cn(
            "flex items-start gap-1.5 text-2xs break-words",
            view.tone === "danger" ? "text-danger-text" : "text-warn-text",
          )}
        >
          <span className="mt-0.5 shrink-0">
            <WarningIcon />
          </span>
          <span className="min-w-0">{view.note}</span>
        </p>
      )}

      {!undeployed || item.lastError === null ? null : (
        <p className="flex items-start gap-1.5 text-2xs break-words text-ink-muted">
          <span className="mt-0.5 shrink-0">
            <WarningIcon />
          </span>
          <span className="min-w-0">{item.lastError}</span>
        </p>
      )}

      {hints.length === 0 ? null : <p className="text-2xs text-ink-muted">{hints.join(" ")}</p>}

      {error === undefined ? null : (
        <p role="alert" className="flex items-start gap-1.5 text-2xs break-words text-danger-text">
          <span className="mt-0.5 shrink-0">
            <WarningIcon />
          </span>
          <span className="min-w-0">{error}</span>
        </p>
      )}

      {busy !== null ? (
        <p className="flex items-center gap-1.5 text-2xs text-ink-soft">
          <RunSpinnerIcon />
          {sharedContentBusyLabel(busy.kind)}…完了まで操作できません。
        </p>
      ) : narrow ? (
        primary === null ? null : (
          <div role="group" aria-label="共有物の操作" className="flex min-w-0 items-center gap-1.5">
            {primary.kind === "open" && item.publicUrl !== null ? (
              <a
                href={item.publicUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="btn-quiet min-w-0 flex-1 singleColumn:min-h-11"
              >
                <ExternalLinkIcon />
                {primary.label}
              </a>
            ) : (
              <button
                type="button"
                onClick={() => runAction(primary)}
                disabled={primary.disabled === true}
                title={primary.reason}
                className={cn("btn-quiet min-w-0 flex-1 singleColumn:min-h-11", actionToneClass(primary))}
              >
                <ActionIcon kind={primary.kind} />
                {primary.label}
              </button>
            )}
          </div>
        )
      ) : rowActions.length === 0 ? null : (
        <div role="group" aria-label="共有物の操作" className="flex flex-wrap items-center gap-2">
          {rowActions.map((action) =>
            action.kind === "open" && item.publicUrl !== null ? (
              <a
                key={action.kind}
                href={item.publicUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="btn-quiet singleColumn:min-h-11"
              >
                <ExternalLinkIcon />
                {action.label}
              </a>
            ) : (
              <button
                key={action.kind}
                type="button"
                onClick={() => runAction(action)}
                disabled={action.disabled === true}
                title={action.reason}
                className={cn("btn-quiet singleColumn:min-h-11", actionToneClass(action))}
              >
                <ActionIcon kind={action.kind} />
                {action.label}
              </button>
            ),
          )}
        </div>
      )}

      {copyFailure === undefined ? null : (
        <p role="alert" className="text-2xs break-words text-danger-text">
          コピーできませんでした。URL を選択してコピーしてください。
        </p>
      )}
    </article>
  );
}
