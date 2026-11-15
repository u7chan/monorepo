import { useId, useMemo, useState } from "react";
import { useConfirm, usePrompt } from "../ConfirmProvider";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import type { SharedContentsManager } from "../../hooks/useSharedContentsManager";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import {
  sharedContentDeleteConfirm,
  sharedContentGroups,
  sharedContentRenameRequest,
  sharedContentSession,
  sharedContentSessionMissing,
  sharedContentQrTarget,
  sharedContentUpdateConfirm,
  SHARED_CONTENT_NO_CREDENTIALS_NOTE,
  type SharedContentsFilter,
  visibleSharedContents,
} from "../../lib/sharedContents";
import { renameInputValue } from "../../lib/confirmDialog";
import type { SessionSummary, SharedContentResponse, SharedContentStatusValue } from "../../types";
import { workdirBusyKind } from "../../lib/sessionBusy";
import { DisclosureChevronIcon, KeyIcon, ShareIcon, WarningIcon } from "../icons";
import { LoadingMark } from "../LoadingMark";
import { QrCodeDialog } from "../QrCodeDialog";
import { SharedContentRow } from "./SharedContentRow";

/** 操作を本文の下へ落とす境界。狭い面では行を 1 列にし、主操作と ⋯ を右寄せにする */
const NARROW_MAX_WIDTH = 600;

export type SharedContentsTabProps = {
  contents: SharedContentsManager;
  /** Cloudflare の接続状態。false のときだけ未登録の案内を出す（未取得の間は出さない） */
  cloudflareConfigured: boolean | undefined;
  /** 全スペースの会話。共有物の会話が一覧に無ければ削除済みとみなす */
  sessions: readonly SessionSummary[];
  /** 会話一覧がいま信頼できるか。信頼できない間は「削除済み」と言い切らず、更新も無効にしない */
  sessionsLoaded: boolean;
  filter: SharedContentsFilter;
  onOpenConnections: () => void;
  /** 公開元の会話を開く。設定を閉じて会話へ移る（スペースをまたぐときは切替を先に行う） */
  onOpenSession?: (sessionId: string, spaceId?: string) => void;
};

export function SharedContentsTab({
  contents,
  cloudflareConfigured,
  sessions,
  sessionsLoaded,
  filter,
  onOpenConnections,
  onOpenSession,
}: SharedContentsTabProps) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const narrow = useViewportWidth() < NARROW_MAX_WIDTH;
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const [qrId, setQrId] = useState<string | null>(null);
  // 見出しを畳む状態。状態ごとのまとまりは画面の都合なので保存しない（開き直したら全部開く）
  const [collapsed, setCollapsed] = useState<ReadonlySet<SharedContentStatusValue>>(() => new Set());
  const groupId = useId();
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.sessionId)), [sessions]);
  const visible = visibleSharedContents(contents.items, filter);
  const groups = sharedContentGroups(visible);
  // フィルタ中は 1 つの状態しか残らないので、見出しは絞り込みの言い換えにしかならない
  const grouped = filter === "all" && groups.length > 1;
  // 共有物の会話と同じ作業フォルダ (同じプロジェクト) で実行中の会話があれば、更新と再試行を押せなくする
  // (未所属の会話は会話ごとの scratch なので、兄弟は存在しない)
  const sessionBusyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of visible) {
      const session = sharedContentSession(item, sessions, sessionsLoaded);
      if (session === undefined) continue;
      const kind = workdirBusyKind({
        selfStatus: session.status,
        sessionId: item.sessionId,
        projectId: session.projectId,
        sessions,
      });
      if (kind !== undefined) ids.add(item.id);
    }
    return ids;
  }, [visible, sessions, sessionsLoaded]);
  // 一括停止中は一覧全体の操作を止める（現在の 1 件は busy が別に持つ）
  const bulkActive = contents.bulkStop?.running === true;
  const sessionMissing = (item: SharedContentResponse) => sharedContentSessionMissing(item, sessionIds, sessionsLoaded);

  const update = async (item: SharedContentResponse) => {
    if (sessionMissing(item)) return;
    if (!(await confirm(sharedContentUpdateConfirm(item)))) return;
    await contents.update(item.id);
  };
  // 空欄・未変更は送らない（設定 → ファイル のリネームと同じ規則）
  const rename = async (item: SharedContentResponse) => {
    const name = renameInputValue(await prompt(sharedContentRenameRequest(item)), item.name);
    if (name === undefined) return;
    await contents.rename(item.id, name);
  };
  const remove = async (item: SharedContentResponse) => {
    if (!(await confirm(sharedContentDeleteConfirm(item)))) return;
    await contents.remove(item.id);
  };
  const toggleGroup = (key: SharedContentStatusValue) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const rows = (items: readonly SharedContentResponse[]) => (
    <ul className="divide-y divide-line">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <SharedContentRow
            item={item}
            narrow={narrow}
            sessionMissing={sessionMissing(item)}
            sessionBusy={sessionBusyIds.has(item.id)}
            session={sharedContentSession(item, sessions, sessionsLoaded)}
            onOpenSession={onOpenSession}
            busy={contents.busy.find((entry) => entry.id === item.id) ?? null}
            bulkActive={bulkActive}
            error={
              contents.bulkStop?.failures.find((failure) => failure.id === item.id)?.message ??
              (contents.error?.id === item.id ? contents.error.message : undefined)
            }
            copied={copiedId === item.id}
            copyFailure={copyFailure(item.id)}
            onCopy={(url, id) => {
              void copyMessage(url, id);
            }}
            onQr={() => {
              setQrId(item.id);
            }}
            onUpdate={() => {
              void update(item);
            }}
            onRename={() => {
              void rename(item);
            }}
            onStop={() => {
              void contents.stop(item.id);
            }}
            onResume={() => {
              void contents.resume(item.id);
            }}
            onRetry={() => {
              void contents.retry(item.id);
            }}
            onDelete={() => {
              void remove(item);
            }}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-0 min-w-0 scroll-pt-10 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 singleColumn:scroll-pt-12">
      <div className="mx-auto grid max-w-5xl gap-3 py-4">
        {cloudflareConfigured === false ? <NoCredentialsBanner onOpenConnections={onOpenConnections} /> : null}
        {contents.failed ? <ListFailureBanner message={contents.listError} /> : null}

        {contents.loading && contents.items.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            <LoadingMark />
            共有物を読み込んでいます。
          </p>
        ) : null}

        {!contents.loading && !contents.failed && contents.items.length === 0 ? (
          <EmptyState onOpenConnections={onOpenConnections} />
        ) : null}

        {contents.items.length === 0 ? null : visible.length === 0 ? (
          <p className="px-1 py-4 text-center text-1xs text-ink-muted">この状態の共有物はありません。</p>
        ) : (
          // 1 件 1 枠のカードをやめ、面を 1 つにして行を区切り線で並べる。
          // overflow-clip は sticky の基準を作らないので、見出しは一覧のスクロールに追従する
          <div className="overflow-clip rounded-xl border border-line bg-panel">
            {grouped
              ? groups.map((group) => {
                  const headingId = `${groupId}-${group.key}`;
                  const listId = `${groupId}-${group.key}-list`;
                  const isCollapsed = collapsed.has(group.key);
                  return (
                    <section key={group.key} aria-labelledby={headingId}>
                      <h2 id={headingId} className="sticky top-0 z-10 m-0 border-b border-line bg-panel">
                        <button
                          type="button"
                          aria-expanded={!isCollapsed}
                          aria-controls={listId}
                          onClick={() => toggleGroup(group.key)}
                          className="tree-fold-toggle flex min-h-9 w-full items-center gap-2 px-4 py-2 text-left text-2xs text-ink-muted transition-colors hover:bg-hover hover:text-ink singleColumn:min-h-11"
                        >
                          <DisclosureChevronIcon />
                          <span className="font-semibold text-ink-soft">{group.label}</span>
                          <span className="text-ink-faint tabular-nums">{group.items.length}</span>
                        </button>
                      </h2>
                      {/* 畳んだときも aria-controls の指す先を残す（hidden で読み上げと焦点から外す） */}
                      <div id={listId} hidden={isCollapsed}>
                        {rows(group.items)}
                      </div>
                    </section>
                  );
                })
              : rows(visible)}
          </div>
        )}
      </div>

      {qrId === null ? null : (
        <QrCodeDialog item={sharedContentQrTarget(contents.items, qrId)} onClose={() => setQrId(null)} />
      )}
    </div>
  );
}

/** 接続未登録の案内。BFF の固定文言をそのまま出し、押す前に登録へ導く */
function NoCredentialsBanner({ onOpenConnections }: { onOpenConnections: () => void }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-accent/40 bg-accent-wash px-3 py-2.5">
      <span className="mt-0.5 shrink-0 text-accent-text">
        <KeyIcon />
      </span>
      <div className="grid min-w-0 gap-1">
        <strong className="text-1xs font-semibold text-accent-text">Cloudflare の接続が未登録です</strong>
        <p className="text-2xs leading-relaxed break-words text-ink-soft">{SHARED_CONTENT_NO_CREDENTIALS_NOTE}</p>
        <p className="text-2xs leading-relaxed break-words text-ink-muted">
          接続を登録するまで、公開・更新・停止・再公開は実行できません。
        </p>
        <button type="button" onClick={onOpenConnections} className="btn-quiet mt-1 w-fit">
          <KeyIcon />
          接続タブを開く
        </button>
      </div>
    </div>
  );
}

/**
 * 一覧全体の取得失敗。1 件の操作失敗（行の中）と混ぜず、表示中の内容が古いことを伝える。
 * BFF の固定文言があるときは言い換えずにそのまま見出しへ出す。
 */
function ListFailureBanner({ message }: { message: string | null }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5">
      <span className="mt-0.5 shrink-0 text-warn-text">
        <WarningIcon />
      </span>
      <div className="grid min-w-0 gap-0.5">
        <strong className="text-1xs font-semibold text-warn-text">
          {message ?? "共有物の一覧を取得できませんでした"}
        </strong>
        <p className="text-2xs leading-relaxed break-words text-ink-soft">
          表示中の内容は最後に取得できたものです。通信を確認して再読み込みしてください。
        </p>
      </div>
    </div>
  );
}

function EmptyState({ onOpenConnections }: { onOpenConnections: () => void }) {
  return (
    <div className="grid justify-items-center gap-1.5 px-4 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-xl border border-line bg-raised text-ink-muted">
        <ShareIcon />
      </span>
      <h3 className="text-1sm font-semibold text-ink">共有物はまだありません</h3>
      <p className="max-w-prose text-1xs leading-relaxed text-ink-muted">
        会話のファイルツリーからディレクトリを共有すると、ここに並びます。公開はファイルツリーの ⋯
        メニューから行います。
      </p>
      <button type="button" onClick={onOpenConnections} className="btn-quiet mt-1.5">
        <KeyIcon />
        接続を確認する
      </button>
    </div>
  );
}
