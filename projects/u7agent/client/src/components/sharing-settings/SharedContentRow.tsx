import { Fragment, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { fileTimeLabel, messageFullTimeLabel } from "../../lib/messageTime";
import { sessionEntryHref } from "../../lib/route";
import {
  type SharedContentAction,
  type SharedContentBusyKind,
  type SharedContentMenuKind,
  sharedContentBusyLabel,
  sharedContentMenuActions,
  sharedContentMenuTimes,
  sharedContentRowAction,
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
  RunSpinnerIcon,
  StopIcon,
  TrashIcon,
  QrCodeIcon,
  RefreshIcon,
  WarningIcon,
} from "../icons";
import { SharedContentMenu } from "./SharedContentMenu";
import { SharedContentThumbnail } from "./SharedContentThumbnail";

export type SharedContentRowProps = {
  item: SharedContentResponse;
  /** 600px 未満。操作を本文の下へ落とし、時刻を 1 つに絞る */
  narrow: boolean;
  /** セッションが削除済み。更新だけを無効にする */
  sessionMissing: boolean;
  /** 公開元の会話と同じ作業フォルダの会話が実行中。更新・再試行を理由付きで無効にする */
  sessionBusy: boolean;
  /** 公開元の会話。会話一覧が信頼できて見つかったときだけ渡す（無い = リンクを出さない） */
  session: SessionSummary | undefined;
  /** 会話リンクの通常クリック。修飾キー付きはブラウザ既定（新規タブ）に任せる */
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
  /** この共有物の操作中。操作を止めて、何をしているかを出す */
  busy: { kind: SharedContentBusyKind } | null;
  /** 一括停止の実行中。一覧全体の操作と ⋯ を止める（閲覧と外部リンクは残す） */
  bulkActive?: boolean;
  /** この共有物の直前の操作失敗（BFF の固定文言） */
  error: string | undefined;
  copied: boolean;
  copyFailure: string | undefined;
  onCopy: (url: string, id: string) => void;
  /** 行のサムネイルを開く。公開中でも押せる（⋯ の表示条件に乗せない） */
  onOpenThumbnail: () => void;
  onQr: () => void;
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
    case "qr":
      return <QrCodeIcon />;
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

/**
 * 管理一覧の 1 行。1 件 1 枠のカードをやめ、1 つの面の中の行として並べる
 * （枠が増えるほど「どれが同じ種類の情報か」を目で拾い直すことになる）。
 * 行が持つのは名前・公開 URL・公開元 / 会話 / 更新の 3 段と、状態ごとの主操作 + ⋯ だけ。
 */
export function SharedContentRow({
  item,
  narrow,
  sessionMissing,
  sessionBusy,
  session,
  onOpenSession,
  busy,
  bulkActive = false,
  error,
  copied,
  copyFailure,
  onCopy,
  onOpenThumbnail,
  onQr,
  onRename,
  onUpdate,
  onStop,
  onResume,
  onRetry,
  onDelete,
}: SharedContentRowProps) {
  const view = shareStatusView(item);
  const handlers: Record<SharedContentMenuKind, () => void> = {
    rename: onRename,
    update: onUpdate,
    stop: onStop,
    qr: onQr,
    delete: onDelete,
  };
  const runAction = (action: SharedContentAction) => {
    switch (action.kind) {
      case "rename":
        onRename();
        return;
      case "qr":
        onQr();
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

  const action = sharedContentRowAction(item, { sessionMissing, sessionBusy });
  const menuActions = sharedContentMenuActions(item, { sessionMissing, sessionBusy });
  const undeployed = isSharedContentUndeployed(item);
  // 停止中も URL は見せる契約だが、開く・コピーは出さない（未デプロイは URL 自体を出さない）
  const showUrl = item.publicUrl !== null && item.status !== "publishing" && !undeployed;
  const copyable = showUrl && view.openUrl !== null;
  // 行に出すのは更新だけにする。公開 / 停止の時刻は ⋯ の先頭へ逃がし、行の高さを時刻の数で変えない
  const time =
    item.status === "publishing" ? { label: "受付", at: item.createdAt } : { label: "更新", at: item.updatedAt };
  const menuTimes = sharedContentMenuTimes(item).map((entry) => ({
    label: entry.label,
    value: fileTimeLabel(entry.at),
    title: messageFullTimeLabel(entry.at),
  }));
  // 狭い面は公開元を落とす。行の中で最も長く、更新の確認ダイアログにも同じ値が出る
  const meta: ReactNode[] = [];
  if (!narrow) {
    meta.push(
      <MetaItem label="公開元">
        <code className="min-w-0 font-mono break-all text-ink-soft">{sharedContentSourceLabel(item)}</code>
      </MetaItem>,
    );
  }
  if (session !== undefined) {
    meta.push(
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
      </MetaItem>,
    );
  }
  meta.push(
    <MetaItem label={time.label}>
      <time dateTime={new Date(time.at).toISOString()} title={messageFullTimeLabel(time.at)} className="tabular-nums">
        {fileTimeLabel(time.at)}
      </time>
    </MetaItem>,
  );

  const hints: string[] = [];
  // 結果待ちの「URL が出る」は URL の行が持つ。ここでは結果不明のときだけ、できることを添える
  if (item.status === "publishing" && item.lastError !== null) {
    hints.push("状態が確定するまで停止だけできます。");
  }
  if (sessionMissing) {
    hints.push("セッションが削除済みのため、更新だけ利用できません。");
  }

  return (
    <div
      aria-busy={busy !== null}
      className={cn("flex min-w-0 gap-4 px-4 py-3 transition-colors", narrow ? "flex-col gap-y-2" : "items-center")}
    >
      <SharedContentThumbnail item={item} narrow={narrow} disabled={bulkActive} onOpen={onOpenThumbnail} />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {/* 長い表示名でも行を押し下げすぎないよう 2 行で切る（全文は title で読める） */}
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

        {item.status === "publishing" && item.lastError === null ? (
          <p className="text-2xs text-ink-muted">公開が完了すると URL を表示します</p>
        ) : showUrl ? (
          <div className="flex min-w-0 items-center gap-1">
            {copyable ? (
              <a
                href={item.publicUrl ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                title={item.publicUrl ?? undefined}
                className="min-w-0 truncate font-mono text-2xs text-ink-soft underline-offset-2 hover:text-accent-text hover:underline"
              >
                {item.publicUrl}
              </a>
            ) : (
              // 停止中は URL を記録として残すが、開く・コピーは出さない（押しても 404 になる）
              <code className="min-w-0 truncate font-mono text-2xs text-ink-faint select-all">{item.publicUrl}</code>
            )}
            {copyable ? (
              <button
                type="button"
                onClick={() => onCopy(item.publicUrl ?? "", item.id)}
                disabled={busy !== null || bulkActive}
                aria-label={copied ? "URL をコピーしました" : "URL をコピー"}
                title={copied ? "URL をコピーしました" : "URL をコピー"}
                className={cn(
                  "grid shrink-0 place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  narrow ? "size-10" : "size-7",
                  copied ? "text-ok" : "text-ink-faint hover:bg-hover hover:text-accent-text",
                )}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-2xs text-ink-muted">
          {meta.map((node, index) => (
            <Fragment key={index}>
              {index === 0 ? null : (
                <span aria-hidden="true" className="text-ink-ghost">
                  ・
                </span>
              )}
              {node}
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

        {busy === null ? null : (
          <p className="flex items-center gap-1.5 text-2xs text-ink-soft">
            <RunSpinnerIcon />
            {sharedContentBusyLabel(busy.kind)}…完了まで操作できません。
          </p>
        )}
      </div>

      <div className={cn("flex min-w-0 shrink-0 items-center gap-2", narrow && "justify-end")}>
        {/* 行の操作だけをまとめる。⋯ をこの group に入れると、開いたメニューの項目まで
            「共有物の操作」に数えられ、行の操作と ⋯ の中身を分けて読めなくなる */}
        <div role="group" aria-label="共有物の操作" className="flex min-w-0 items-center gap-2">
          {busy !== null || action === null ? null : action.kind === "open" && item.publicUrl !== null ? (
            <a
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
              type="button"
              onClick={() => runAction(action)}
              disabled={action.disabled === true || bulkActive}
              title={action.reason}
              className={cn("btn-quiet singleColumn:min-h-11", actionToneClass(action))}
            >
              <ActionIcon kind={action.kind} />
              {action.label}
            </button>
          )}
        </div>
        {/* ⋯ は行の右端に固定する。名前や状態の幅で位置が動かず、主操作の幅も変えない。
            操作中は出さない（二重操作のガードが後からの要求を黙って捨てて画面が無反応に見える） */}
        {busy !== null || bulkActive || menuActions.length === 0 ? null : (
          <SharedContentMenu
            name={item.name}
            actions={menuActions}
            meta={menuTimes}
            onSelect={(kind) => handlers[kind]()}
          />
        )}
      </div>

      {copyFailure === undefined ? null : (
        <p role="alert" className="text-2xs break-words text-danger-text">
          コピーできませんでした。URL を選択してコピーしてください。
        </p>
      )}
    </div>
  );
}
