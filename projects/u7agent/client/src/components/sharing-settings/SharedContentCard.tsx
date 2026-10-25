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
  /** 600px 未満。操作を主操作 + コピー + ⋯ に畳み、meta を絞る */
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
    case "copy":
      return <CopyIcon />;
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
  onUpdate,
  onStop,
  onResume,
  onRetry,
  onDelete,
}: SharedContentCardProps) {
  const view = shareStatusView(item);
  const handlers: Record<SharedContentMenuKind, () => void> = {
    update: onUpdate,
    stop: onStop,
    delete: onDelete,
  };
  const runAction = (action: SharedContentAction) => {
    switch (action.kind) {
      case "copy":
        if (item.publicUrl !== null) onCopy(item.publicUrl, item.id);
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

  const desktopActions = sharedContentActions(item, { sessionMissing });
  const menuActions = sharedContentMenuActions(item, { sessionMissing });
  const primary = sharedContentPrimaryAction(item, { sessionMissing });
  const undeployed = isSharedContentUndeployed(item);

  // 停止中も URL を見せる契約は `openUrl` (外部で開いてよい URL) と別なので、未デプロイの判定を足して消す
  const url =
    item.publicUrl === null || item.status === "publishing" || undeployed ? null : (
      <code
        className={cn(
          "block min-w-0 font-mono text-2xs break-all text-ink-soft select-all",
          item.status === "stopped" && "text-ink-faint",
        )}
      >
        {item.publicUrl}
      </code>
    );

  // 狭い面では「更新」を出さず、公開元と 1 つの時刻だけにする（停止中は停止時刻）
  const time =
    item.status === "publishing"
      ? { label: "受付", at: item.createdAt }
      : narrow && item.status === "stopped"
        ? { label: "停止", at: item.stoppedAt ?? item.updatedAt }
        : { label: "更新", at: item.updatedAt };

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
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="min-w-0 text-1sm font-semibold break-words text-ink-strong">{item.name}</h3>
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

      {url}
      {item.status === "publishing" ? (
        <p className="text-2xs text-ink-muted">公開が完了すると URL を表示します</p>
      ) : null}

      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-muted">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <b className="font-medium text-ink-faint">公開元</b>
          <code className="min-w-0 font-mono break-all text-ink-soft">{sharedContentSourceLabel(item)}</code>
        </span>
        {session === undefined ? null : (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <b className="font-medium text-ink-faint">会話</b>
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
          </span>
        )}
        <span className="flex items-baseline gap-1.5">
          <b className="font-medium text-ink-faint">{time.label}</b>
          <time
            dateTime={new Date(time.at).toISOString()}
            title={messageFullTimeLabel(time.at)}
            className="tabular-nums"
          >
            {fileTimeLabel(time.at)}
          </time>
        </span>
        {!narrow && item.publishedAt !== null ? (
          <span className="flex items-baseline gap-1.5">
            <b className="font-medium text-ink-faint">公開</b>
            <time
              dateTime={new Date(item.publishedAt).toISOString()}
              title={messageFullTimeLabel(item.publishedAt)}
              className="tabular-nums"
            >
              {fileTimeLabel(item.publishedAt)}
            </time>
          </span>
        ) : null}
        {!narrow && item.stoppedAt !== null ? (
          <span className="flex items-baseline gap-1.5">
            <b className="font-medium text-ink-faint">停止</b>
            <time
              dateTime={new Date(item.stoppedAt).toISOString()}
              title={messageFullTimeLabel(item.stoppedAt)}
              className="tabular-nums"
            >
              {fileTimeLabel(item.stoppedAt)}
            </time>
          </span>
        ) : null}
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
        <div className="flex min-w-0 items-center gap-1.5">
          {primary === null ? null : primary.kind === "open" && item.publicUrl !== null ? (
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
          {view.openUrl === null ? null : (
            <button
              type="button"
              onClick={() => onCopy(item.publicUrl ?? "", item.id)}
              className="btn-quiet min-w-0 flex-1 singleColumn:min-h-11"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "コピーしました" : "URL をコピー"}
            </button>
          )}
          {menuActions.length === 0 ? null : (
            <SharedContentMenu name={item.name} actions={menuActions} onSelect={(kind) => handlers[kind]()} />
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {desktopActions.map((action) =>
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
                className={cn(
                  "btn-quiet singleColumn:min-h-11",
                  actionToneClass(action),
                  action.danger === true && "ml-auto",
                )}
              >
                {action.kind === "copy" && copied ? <CheckIcon /> : <ActionIcon kind={action.kind} />}
                {action.kind === "copy" && copied ? "コピーしました" : action.label}
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
