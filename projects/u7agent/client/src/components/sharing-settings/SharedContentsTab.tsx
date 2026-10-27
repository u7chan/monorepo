import { useMemo, useState } from "react";
import { useConfirm, usePrompt } from "../ConfirmProvider";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import type { SharedContentsManager } from "../../hooks/useSharedContentsManager";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import {
  sharedContentDeleteConfirm,
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
import type { SessionSummary, SharedContentResponse } from "../../types";
import { KeyIcon, ShareIcon, WarningIcon } from "../icons";
import { LoadingMark } from "../LoadingMark";
import { QrCodeDialog } from "../QrCodeDialog";
import { SharedContentCard } from "./SharedContentCard";

/** 操作をカード内に並べるか、主操作 + コピー + ⋯ に畳むかの境界。モックの狭い面に合わせる */
const NARROW_MAX_WIDTH = 600;

export type SharedContentsTabProps = {
  contents: SharedContentsManager;
  /** Cloudflare の接続状態。false のときだけ未登録の案内を出す（未取得の間は出さない） */
  cloudflareConfigured: boolean | undefined;
  /** 全スペースの会話。共有物の会話が一覧に無ければ削除済みとみなす */
  sessions: readonly SessionSummary[];
  /** 会話一覧がいま信頼できるか。信頼できない間は「削除済み」と言い切らない */
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
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.sessionId)), [sessions]);
  const visible = visibleSharedContents(contents.items, filter);
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

  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
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
          <ul className="grid min-w-0 gap-2.5">
            {visible.map((item) => (
              <li key={item.id} className="min-w-0">
                <SharedContentCard
                  item={item}
                  narrow={narrow}
                  sessionMissing={sessionMissing(item)}
                  session={sharedContentSession(item, sessions, sessionsLoaded)}
                  onOpenSession={onOpenSession}
                  busy={contents.busy.find((entry) => entry.id === item.id) ?? null}
                  bulkActive={bulkActive}
                  error={contents.error?.id === item.id ? contents.error.message : undefined}
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
 * 一覧全体の取得失敗。1 件の操作失敗（カード内）と混ぜず、表示中の内容が古いことを伝える。
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
