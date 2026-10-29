import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSharedContents, type SharePreviewState, type SharedContentsController } from "../hooks/useSharedContents";
import { useMessageCopy } from "../hooks/useMessageCopy";
import { cn } from "../lib/cn";
import {
  SHARE_CLOSE_HINT,
  SHARE_CONFIRM_NOTES,
  SHARE_CONFIRM_SUMMARY,
  SHARE_CREATE_SECONDARY_NOTE,
  SHARE_NAME_LOCKED_NOTE,
  SHARE_NAME_MAX_LENGTH,
  SHARE_PREVIEW_FAILED_UPDATE_HINT,
  SHARE_PUBLISHING_NOTE,
  SHARE_UPDATE_CONFIRM_NOTES,
  isSharedContentUndeployed,
  sharePrimaryAction,
  shareStatusView,
  shareUpdateNote,
  sharedContentQrTarget,
  type ShareStatusView,
} from "../lib/sharedContents";
import { sharePreviewSummary } from "../lib/sharedContentPreview";
import type { SharedContentResponse } from "../types";
import { ExternalLinkIcon, QrCodeIcon, RunSpinnerIcon, ShareIcon, WarningIcon } from "./icons";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { LoadingMark } from "./LoadingMark";
import { QrCodeDialog } from "./QrCodeDialog";

/** 行の ⋯ から渡す公開対象 */
export type ShareContentTarget = {
  /** 作業フォルダ面の root 相対 (= セッションの作業ディレクトリ相対) のパス。`.` は作業フォルダ自身 */
  directory: string;
  /** 表示名の入力欄の初期値。空なら未入力で始め、送信時に API がディレクトリ名へ落とす */
  defaultName: string;
};

export type ShareContentDialogProps = {
  sessionId: string;
  target: ShareContentTarget;
  /**
   * 実行中のために公開を押せない理由。ダイアログを開いた後に run が始まるケースをここで塞ぐ
   * (run が終われば undefined に戻り、押せるようになる)
   */
  runBlockedReason?: string;
  singleColumn?: boolean;
  onClose: () => void;
};

/**
 * 行の ⋯ から 1 ディレクトリを公開するダイアログ。停止・削除をここへ足さないのは、取り消しにくい操作の確認と結果だけを 1 画面に閉じるため
 * （一覧の管理は 設定 → 共有）。振る舞いは `docs/static-sharing.md#gui共有ダイアログ` を正とする。
 */
export function ShareContentDialog({ sessionId, target, ...props }: ShareContentDialogProps) {
  return (
    <ShareContentDialogView
      {...props}
      target={target}
      share={useSharedContents({ sessionId, directory: target.directory })}
    />
  );
}

export type ShareContentDialogViewProps = {
  target: ShareContentTarget;
  share: SharedContentsController;
  /** 実行中のために公開を押せない理由 (undefined なら押せる) */
  runBlockedReason?: string;
  singleColumn?: boolean;
  onClose: () => void;
};

/** ダイアログの 2 タブ。開閉で捨てるローカル状態で、URL には載せない */
type ShareTab = "publish" | "items";

export function ShareContentDialogView({
  target,
  share,
  runBlockedReason,
  singleColumn = false,
  onClose,
}: ShareContentDialogViewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 表示名は作成時にだけ決める (既存の共有物の名前は 設定 → 共有 でも変えない)
  const [name, setName] = useState(target.defaultName);
  const [tab, setTab] = useState<ShareTab>("publish");
  const [qrId, setQrId] = useState<string | null>(null);
  const active = share.activeId === null ? undefined : share.items.find((item) => item.id === share.activeId);
  // 受付した 1 件は上の結果に出す (同じ URL とボタンを一覧にも並べない)。閉じて開き直すと一覧だけになる
  const listed = share.activeId === null ? share.items : share.items.filter((item) => item.id !== share.activeId);
  // 受付した後は同じディレクトリをもう一度公開しない (Worker の枠と URL を無駄に増やさない)
  const started = share.activeId !== null || share.submitting;
  // 受付直後は一覧に active がまだ現れない (一覧の GET が遅延・失敗する)。その間も公開中として扱う
  // (公開が終わったと確認できるまで、閉じても続く案内を消さない)
  const busy =
    share.submitting || (share.activeId !== null && (active === undefined || active.status === "publishing"));
  // 受付後は結果と再送の導線を混ぜないため「公開」タブへ固定する (一覧は 設定 → 共有 で管理する)
  const activeTab: ShareTab = started ? "publish" : tab;

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

  // 同じ公開元の共有物があれば、主操作を「更新する」にして新しい URL を増やさない。
  // 公開中だけは、閉じて開き直して `started` が失われても再送させない (Worker と URL を二重に作らない)
  const sourcePath = share.preview.status === "ready" ? share.preview.preview.sourcePath : null;
  const primary = sharePrimaryAction(sourcePath, share.items);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || started || primary.kind === "publishing" || runBlockedReason !== undefined) return;
    // フッターは両タブに出すので、一覧側から確定しても結果は「公開」タブに出す
    setTab("publish");
    if (primary.kind === "update") void share.update(primary.item.id);
    else void share.share(target.directory, name);
  };

  // 副次の新規作成は、押したときだけ実行する (同じ公開元の更新がある間の既定は更新)
  const createNew = () => {
    if (busy || started || primary.kind === "publishing" || runBlockedReason !== undefined) return;
    setTab("publish");
    void share.share(target.directory, name);
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
          : "m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] rounded-xl border shadow-panel",
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
        {/* タブは本文と外へ分けて固定する (切り替えてもヘッダ・フッターの位置が動かない) */}
        <div role="tablist" aria-label="共有の表示" className="flex min-w-0 shrink-0 gap-1 border-b border-line px-4">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "publish"}
            onClick={() => setTab("publish")}
            className={cn("tab-item", activeTab === "publish" && "tab-item-active")}
          >
            公開
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "items"}
            // 受付後は結果と一覧の導線を混ぜないため「公開」タブに固定する
            disabled={started}
            onClick={() => setTab("items")}
            className={cn(
              "tab-item disabled:cursor-not-allowed disabled:opacity-45",
              activeTab === "items" && "tab-item-active",
            )}
          >
            共有物（{share.items.length}）
          </button>
        </div>

        {/* スクロールは本文にだけ残す。切り替えない面も描いたまま hidden で隠し、開閉で入力欄を作り直さない */}
        <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          <div hidden={activeTab !== "publish"} className="grid content-start gap-3.5">
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
              <>
                {primary.kind === "update" ? <ShareUpdateTarget item={primary.item} /> : null}
                {primary.kind === "publishing" ? (
                  <p className="break-words text-warn">{SHARE_PUBLISHING_NOTE}</p>
                ) : null}
                {primary.kind === "create" ? (
                  <label className="grid gap-1">
                    <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">表示名</span>
                    <input
                      type="text"
                      value={name}
                      maxLength={SHARE_NAME_MAX_LENGTH}
                      // 空欄で送ると API がディレクトリ名へ落とす (root はセッション ID になる)
                      placeholder="未入力ならディレクトリ名"
                      onChange={(event) => setName(event.currentTarget.value)}
                      className="field text-xs"
                    />
                    {/* URL は共有物の id から作る script 名で決まり、表示名では変わらない */}
                    <span className="text-1xs text-ink-muted">表示名です。公開 URL は変わりません</span>
                  </label>
                ) : null}
                <SharePreview state={share.preview} />
                {/* プレビューが失敗すると公開元が分からない。存在を断定せず、更新する逃げ道だけを案内する */}
                {share.preview.status === "failed" ? (
                  <p className="text-1xs break-words text-ink-muted">{SHARE_PREVIEW_FAILED_UPDATE_HINT}</p>
                ) : null}
                {/* 4 行は毎回読ませたい量ではないので畳み、summary だけで要点が読めるようにする */}
                <CollapsibleNotice summary={SHARE_CONFIRM_SUMMARY}>
                  {(primary.kind === "update" ? SHARE_UPDATE_CONFIRM_NOTES : SHARE_CONFIRM_NOTES).map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </CollapsibleNotice>
              </>
            )}

            {share.error === undefined ? null : (
              <p role="alert" className="break-words text-warn">
                {share.error}
              </p>
            )}

            {started ? <ShareOutcome active={active} submitting={share.submitting} onQr={setQrId} /> : null}

            {/* 閉じると受付済みの表示は失われるが、公開はサーバー側で続く。閉じるは塞がない */}
            {busy ? <p className="text-1xs break-words text-ink-muted">{SHARE_CLOSE_HINT}</p> : null}
          </div>

          <div hidden={activeTab !== "items"} className="grid content-start gap-3.5">
            {/* 受付した 1 件は「公開」タブの結果に出す。他に何も無いときは空の見出しを残さない */}
            {listed.length === 0 && active !== undefined && !share.failed ? null : (
              <section className="grid gap-2">
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
                    <ShareListItem key={item.id} item={item} onQr={setQrId} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>

        {/* 受付した後の閉じる導線はヘッダに 1 つだけにする (同じラベルのボタンを 2 つ並べない) */}
        {started ? null : (
          <footer className="grid shrink-0 gap-1.5 border-t border-line px-4 py-3">
            {/* 副次の新規作成は Worker を 1 つ増やすので、押す前に行を添える */}
            {primary.kind === "update" ? (
              <p className="text-right text-1xs break-words text-ink-muted">{SHARE_CREATE_SECONDARY_NOTE}</p>
            ) : null}
            {/* 実行中は公開しない (受付時の ZIP が書き換え途中の成果物になり得る)。理由は BFF の 409 と同じ条件 */}
            {runBlockedReason === undefined ? null : (
              <p className="text-right text-1xs break-words text-warn">{runBlockedReason}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button ref={cancelRef} type="button" className="btn-quiet singleColumn:min-h-11" onClick={onClose}>
                キャンセル
              </button>
              {primary.kind === "update" ? (
                <button
                  type="button"
                  className="btn-quiet singleColumn:min-h-11"
                  disabled={busy || runBlockedReason !== undefined}
                  onClick={createNew}
                >
                  新しく共有
                </button>
              ) : null}
              {/* 公開中は主操作を出さず、理由だけを本文に出す */}
              {primary.kind === "publishing" ? null : (
                <button
                  type="submit"
                  className="btn-primary singleColumn:min-h-11"
                  disabled={busy || runBlockedReason !== undefined}
                >
                  <ShareIcon />
                  {primary.kind === "update" ? "更新する" : "共有する"}
                </button>
              )}
            </div>
          </footer>
        )}
      </form>
      {qrId === null ? null : (
        <QrCodeDialog item={sharedContentQrTarget(share.items, qrId)} onClose={() => setQrId(null)} />
      )}
    </dialog>
  );
}

/** 更新の対象。更新先の URL は既に決まっているので、開く / コピーを添えずに表示だけする */
function ShareUpdateTarget({ item }: { item: SharedContentResponse }) {
  return (
    <section aria-label="更新する共有物" className="grid gap-1.5 rounded-lg border border-line bg-soft px-3 py-2.5">
      <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">更新する共有物</h3>
      <p className="break-words text-ink-soft">{item.name}</p>
      <p className="break-words text-ink-soft">{shareUpdateNote(item)}</p>
      {/* 受付時に確定した URL。未デプロイ / failed でも、記録がある限り更新先として見せる */}
      {item.publicUrl === null ? null : (
        <code className="block min-w-0 text-2xs break-all text-ink-soft select-all">{item.publicUrl}</code>
      )}
      <p className="text-1xs break-words text-ink-muted">{SHARE_NAME_LOCKED_NOTE}</p>
    </section>
  );
}

/**
 * 公開前のプレビュー。取得中 / 失敗 / 成功を分けて出し、失敗しても公開の操作は塞がない
 * （プレビューは補助で、公開されるものの確定は公開ジョブの検証）。
 */
function SharePreview({ state }: { state: SharePreviewState }) {
  const preview = state.status === "ready" ? state.preview : null;
  const summary = preview === null ? null : sharePreviewSummary(preview);
  return (
    <section aria-label="公開される内容" className="grid gap-1.5 rounded-lg border border-line bg-soft px-3 py-2.5">
      <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">公開される内容</h3>
      {state.status === "loading" ? (
        <p className="flex items-center gap-1.5 text-ink-muted">
          <RunSpinnerIcon />
          確認しています…
        </p>
      ) : null}
      {state.status === "failed" ? (
        <>
          <p role="alert" className="break-words text-warn">
            {state.message}
          </p>
          <p className="text-1xs break-words text-ink-muted">プレビューは取得できませんでしたが、共有はできます。</p>
        </>
      ) : null}
      {preview === null || summary === null ? null : (
        <>
          {summary.totals === null ? null : <p className="break-words text-ink-soft">{summary.totals}</p>}
          {summary.rows.length === 0 ? null : (
            <ul className="grid gap-0.5">
              {summary.rows.map((row) => (
                <li key={row.name} className="flex min-w-0 items-baseline justify-between gap-2 text-1xs">
                  <span className="min-w-0 break-all text-ink-soft">{row.name}</span>
                  <span className="shrink-0 text-ink-muted">{row.size}</span>
                </li>
              ))}
            </ul>
          )}
          {summary.notes.map((note) => (
            <p key={note} className="text-1xs break-words text-ink-muted">
              {note}
            </p>
          ))}
          {preview.problems.length === 0 ? null : (
            <ul className="grid gap-0.5">
              {preview.problems.map((problem) => (
                <li key={problem} className="flex min-w-0 gap-1.5 break-words text-warn">
                  <span className="shrink-0">
                    <WarningIcon />
                  </span>
                  <span className="min-w-0">{problem}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="text-1xs break-words text-ink-muted">
        この時点の見え方です。公開されるものは公開時に検証し直します。
      </p>
    </section>
  );
}

/** 受付した 1 件の状態。公開中は操作を出さず、完了で URL・共有 ID・開く / QR / コピーを出す */
function ShareOutcome({
  active,
  submitting,
  onQr,
}: {
  active: SharedContentResponse | undefined;
  submitting: boolean;
  onQr: (id: string) => void;
}) {
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
      {view.openUrl === null ? null : <ShareUrl url={view.openUrl} id={active.id} onQr={() => onQr(active.id)} />}
      <ShareId id={active.id} />
      <ShareNote view={view} />
    </div>
  );
}

/** この会話の共有物 1 件。公開済みなら URL と開く / QR / コピーを出す */
function ShareListItem({ item, onQr }: { item: SharedContentResponse; onQr: (id: string) => void }) {
  const view = shareStatusView(item);
  return (
    <li className="grid min-w-0 gap-1 border-b border-line pb-2 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate font-semibold text-ink-strong">{item.name}</span>
        <ShareStatusLine view={view} />
      </div>
      {view.openUrl === null ? null : <ShareUrl url={view.openUrl} id={item.id} onQr={() => onQr(item.id)} />}
      <ShareId id={item.id} />
      <ShareNote view={view} />
      {/* 未デプロイの固定文言とは別に、BFF が分類した理由を表示だけに使う */}
      {isSharedContentUndeployed(item) && item.lastError !== null ? (
        <p className="text-1xs break-words text-ink-muted">{item.lastError}</p>
      ) : null}
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
  return (
    <p className={cn("text-1xs break-words", view.tone === "danger" ? "text-danger-text" : "text-warn")}>{view.note}</p>
  );
}

/** 公開 URL と、外部タブで開く / QR / クリップボードへコピーの 3 操作。長い URL は折り返す */
function ShareUrl({ url, id, onQr }: { url: string; id: string; onQr: () => void }) {
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
        <button type="button" className="btn-quiet" onClick={onQr}>
          <QrCodeIcon />
          QR コード
        </button>
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
