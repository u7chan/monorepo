import { useEffect, useRef, type FormEvent } from "react";
import { useSharedContents, type SharedContentsController } from "../hooks/useSharedContents";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { cn } from "../lib/cn";
import { SHARE_CONFIRM_NOTES, shareStatusView, type ShareStatusView } from "../lib/sharedContents";
import type { SharedContentResponse } from "../types";
import { ExternalLinkIcon, RunSpinnerIcon, ShareIcon, WarningIcon } from "./icons";
import { LoadingMark } from "./LoadingMark";

/** 行の ⋯ から渡す公開対象。表示名は API がディレクトリ名を既定にするので、ここでは指定しない */
export type ShareContentTarget = {
  /** 作業フォルダ面の root 相対 (= セッションの作業ディレクトリ相対) のパス */
  directory: string;
};

export type ShareContentDialogProps = {
  sessionId: string;
  target: ShareContentTarget;
  singleColumn?: boolean;
  onClose: () => void;
};

/**
 * 行の ⋯ から 1 ディレクトリを公開するダイアログ。停止・削除・更新をここへ足さないのは、取り消しにくい操作の確認と結果だけを 1 画面に閉じるため
 * （一覧の管理は 設定 → 共有）。振る舞いは `docs/static-sharing.md#gui共有ダイアログ` を正とする。
 */
export function ShareContentDialog({ sessionId, ...props }: ShareContentDialogProps) {
  return <ShareContentDialogView {...props} share={useSharedContents({ sessionId })} />;
}

export type ShareContentDialogViewProps = {
  target: ShareContentTarget;
  share: SharedContentsController;
  singleColumn?: boolean;
  onClose: () => void;
};

export function ShareContentDialogView({ target, share, singleColumn = false, onClose }: ShareContentDialogViewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const active = share.activeId === null ? undefined : share.items.find((item) => item.id === share.activeId);
  // 受付した 1 件は上の結果に出す (同じ URL とボタンを一覧にも並べない)。閉じて開き直すと一覧だけになる
  const listed = share.activeId === null ? share.items : share.items.filter((item) => item.id !== share.activeId);
  // 受付した後は同じディレクトリをもう一度公開しない (Worker の枠と URL を無駄に増やさない)
  const started = share.activeId !== null || share.submitting;
  const busy = share.submitting || active?.status === "publishing";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 初期焦点は取り消し側に置く (公開は取り消しにくいので、Enter で確定させない)
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || started) return;
    void share.share(target.directory);
  };

  return (
    <dialog
      ref={dialogRef}
      // `cancel` / `close` は React の祖先 (作業環境のシート) の handler まで届く。止めないと Escape 1 回で背面まで閉じる
      // (既定動作の「このダイアログを閉じる」は止めない)
      onCancel={(event) => {
        event.stopPropagation();
      }}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      aria-modal="true"
      aria-label="共有"
      tabIndex={-1}
      // Escape はダイアログだけを閉じる (作業環境の面やチャットへ戻る操作へ届かせない)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className={cn(
        "flex flex-col overflow-hidden border-line bg-panel p-0 text-ink",
        singleColumn
          ? "m-0 h-dvh max-h-none w-screen max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(420px,92vw)] rounded-xl border shadow-panel",
      )}
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">SHARE</div>
          <h2 className="text-md font-semibold text-ink-strong">共有</h2>
        </div>
        <button type="button" onClick={onClose} className="btn-quiet">
          閉じる
        </button>
      </header>

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-3.5 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          <div className="grid gap-0.5">
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
              公開するディレクトリ
            </span>
            {/* 長いパスでも横に溢れないよう、折り返しは code の break-all に任せる */}
            <code className="block min-w-0 rounded-md border border-line bg-soft px-2 py-1.5 text-2xs break-all text-ink-soft">
              {target.directory}
            </code>
            <span className="text-1xs text-ink-muted">この会話の作業フォルダからの相対パスです。</span>
          </div>

          {started ? null : (
            <ul className="grid gap-1.5">
              {SHARE_CONFIRM_NOTES.map((note) => (
                <li key={note} className="flex min-w-0 gap-1.5 break-words text-ink-soft">
                  <span className="shrink-0 text-warn">
                    <WarningIcon />
                  </span>
                  <span className="min-w-0">{note}</span>
                </li>
              ))}
            </ul>
          )}

          {share.error === undefined ? null : (
            <p role="alert" className="break-words text-warn">
              {share.error}
            </p>
          )}

          {started ? <ShareOutcome active={active} submitting={share.submitting} /> : null}

          {/* 受付した 1 件は上の結果に出す。他に何も無いときは空の見出しを残さない */}
          {listed.length === 0 && active !== undefined && !share.failed ? null : (
            <section className="grid gap-2 border-t border-line pt-3">
              <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">この会話の共有物</h3>
              {share.loading ? (
                <p className="text-ink-muted">
                  <LoadingMark />
                </p>
              ) : null}
              {share.failed ? (
                <p role="alert" className="break-words text-warn">
                  共有物の一覧を取得できませんでした。
                </p>
              ) : null}
              {!share.loading && !share.failed && listed.length === 0 ? (
                <p className="text-ink-muted">この会話の共有物はまだありません。</p>
              ) : null}
              <ul className="grid gap-2">
                {listed.map((item) => (
                  <ShareListItem key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* 受付した後の閉じる導線はヘッダに 1 つだけにする (同じラベルのボタンを 2 つ並べない) */}
        {started ? null : (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
            <button ref={cancelRef} type="button" className="btn-quiet singleColumn:min-h-11" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn-primary singleColumn:min-h-11" disabled={busy}>
              <ShareIcon />
              共有する
            </button>
          </footer>
        )}
      </form>
    </dialog>
  );
}

/** 受付した 1 件の状態。公開中は操作を出さず、完了で URL・共有 ID・開く / コピーを出す */
function ShareOutcome({ active, submitting }: { active: SharedContentResponse | undefined; submitting: boolean }) {
  if (submitting) {
    return (
      <p aria-live="polite" className="flex items-center gap-1.5 text-ink-soft">
        <RunSpinnerIcon />
        公開を受け付けています…
      </p>
    );
  }
  if (active === undefined) return null;
  const view = shareStatusView(active);
  return (
    <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-3 py-2.5">
      <ShareStatusLine view={view} />
      {view.openUrl === null ? null : <ShareUrl url={view.openUrl} id={active.id} />}
      <ShareId id={active.id} />
      <ShareNote view={view} />
    </div>
  );
}

/** この会話の共有物 1 件。公開済みなら URL と開く / コピーを出す */
function ShareListItem({ item }: { item: SharedContentResponse }) {
  const view = shareStatusView(item);
  return (
    <li className="grid min-w-0 gap-1 border-b border-line pb-2 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate font-semibold text-ink-strong">{item.name}</span>
        <ShareStatusLine view={view} />
      </div>
      {view.openUrl === null ? null : <ShareUrl url={view.openUrl} id={item.id} />}
      <ShareId id={item.id} />
      <ShareNote view={view} />
    </li>
  );
}

/**
 * 共有 ID。`failed` は URL が無く、同じディレクトリの再公開は名前が重なるため、一覧でも出さないと識別できない
 */
function ShareId({ id }: { id: string }) {
  return (
    <p className="text-1xs break-all text-ink-muted">
      共有 ID: <span className="text-ink-soft select-all">{id}</span>
    </p>
  );
}

/** 状態の 1 行。色だけに頼らず、公開中はスピナーを添える */
function ShareStatusLine({ view }: { view: ShareStatusView }) {
  const tone =
    view.tone === "ok"
      ? "text-ok"
      : view.tone === "warn"
        ? "text-warn"
        : view.tone === "danger"
          ? "text-danger-text"
          : "text-ink-soft";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-2xs", tone)}>
      {view.tone === "busy" ? <RunSpinnerIcon /> : null}
      {view.label}
    </span>
  );
}

/** 失敗・結果不明の理由。BFF の固定文言をそのまま出し、生の応答は画面へ出さない */
function ShareNote({ view }: { view: ShareStatusView }) {
  if (view.note === null) return null;
  return <p className="text-1xs break-words text-warn">{view.note}</p>;
}

/** 公開 URL と、外部タブで開く / クリップボードへコピーの 2 操作。長い URL は折り返す */
function ShareUrl({ url, id }: { url: string; id: string }) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const failure = copyFailure(id);
  return (
    <div className="grid min-w-0 gap-1">
      <code className="block min-w-0 text-2xs break-all text-ink-soft select-all">{url}</code>
      <div className="flex flex-wrap items-center gap-2">
        <a href={url} target="_blank" rel="noreferrer noopener" className="btn-quiet">
          <ExternalLinkIcon />
          開く
        </a>
        <button type="button" className="btn-quiet" onClick={() => void copyMessage(url, id)}>
          {copiedId === id ? "コピーしました" : "URL をコピー"}
        </button>
      </div>
      {failure === undefined ? null : (
        <p role="alert" className="text-1xs break-words text-danger-text">
          コピーできませんでした。URL を選択してコピーしてください。
        </p>
      )}
    </div>
  );
}
