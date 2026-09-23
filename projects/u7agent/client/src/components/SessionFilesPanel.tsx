import { useEffect, useRef, useState } from "react";
import type { FileRefRequest } from "../lib/fileRefRequest";
import { FileBrowser } from "./FileBrowser";
import { CloseIcon, RefreshIcon } from "./icons";

export type SessionFilesPanelProps = {
  /** 選択中セッションの作業フォルダ (ワークスペース root 相対)。パネル / シートの root */
  root: string;
  /** run が終わった回数 (ChatState.runEndSeq)。増えるたびに一覧と開いている本文を取り直す */
  runEndSeq: number;
  onClose: () => void;
  /** 未消費のファイル参照の要求 (App の pending)。適用は FileBrowser が行う */
  openRequest?: FileRefRequest | null;
  /** 適用済みの seq を App へ返し、pending を消す */
  onHandled?: (seq: number) => void;
};

function SessionFilesContent({
  root,
  runEndSeq,
  onClose,
  openRequest,
  onHandled,
  compact,
}: SessionFilesPanelProps & { compact: boolean }) {
  const [manualReload, setManualReload] = useState(0);
  // ヘッダの「再読み込み」と run_end を 1 つの token にまとめる。どちらも単調なので、合計が
  // 変わったときだけ取り直す。描画間の runStatus の差は使わない (run_start と run_end が同じ
  // バッチで届くと running を観測できず、run_end を取りこぼす。カウンタは reducer が進める)
  const reloadToken = manualReload + runEndSeq;

  return (
    <>
      <header
        className={
          compact
            ? "flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3"
            : "flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-3 py-2"
        }
      >
        <div className="min-w-0 flex-1">
          {compact ? (
            <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">SESSION FILES</div>
          ) : null}
          <h2
            className={
              compact
                ? "truncate font-semibold text-base text-ink-strong"
                : "truncate text-xs font-semibold text-ink-strong"
            }
          >
            セッションのファイル
          </h2>
          {compact ? (
            <code className="block truncate text-2xs leading-normal text-ink-muted" title={root}>
              {root}
            </code>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setManualReload((count) => count + 1)} className="btn-quiet">
            <RefreshIcon />
            再読み込み
          </button>
          <button type="button" onClick={onClose} aria-label="閉じる" title="閉じる" className="btn-quiet px-2.5">
            <CloseIcon />
            {compact ? "閉じる" : null}
          </button>
        </div>
      </header>
      <FileBrowser root={root} reloadToken={reloadToken} openRequest={openRequest} onHandled={onHandled} />
    </>
  );
}

/**
 * desktop のチャット右パネル。root の切替 (セッションの切替) は呼び出し側の key が mount ごとに
 * 入れ替える。幅が狭いので、ツリーとプレビューは FileBrowser 側のコンテナ判定で縦に積む。
 */
export function SessionFilesPanel(props: SessionFilesPanelProps) {
  return (
    <aside
      aria-label="セッションのファイル"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-line bg-panel"
    >
      <SessionFilesContent {...props} compact={false} />
    </aside>
  );
}

/**
 * compact のセッションファイル。チャットの表示幅を奪わないよう全画面 modal sheet にし、
 * desktop と同じ FileBrowser を viewport 幅いっぱいで使う。
 */
export type SessionFilesSheetProps = SessionFilesPanelProps & {
  /** ファイル参照から開いたときの起点。閉じたときに focus を戻す (無ければ表示時の activeElement) */
  returnFocus?: HTMLElement | null;
};

export function SessionFilesSheet({ returnFocus, ...props }: SessionFilesSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // showModal は最初の操作要素へ focus を移すため、戻し先は showModal の前に決める
    const origin = returnFocus ?? (document.activeElement as HTMLElement | null);
    if (!dialog.open) {
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => {
      // 起点がセッション切替などで消えていたら focus を移さない (body へ落とさない)
      if (origin?.isConnected) origin.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={props.onClose}
      tabIndex={-1}
      aria-modal="true"
      aria-label="セッションのファイル"
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="m-0 grid h-dvh max-h-none w-screen max-w-none grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-none border-0 bg-panel p-0 text-ink"
    >
      <SessionFilesContent {...props} compact />
    </dialog>
  );
}
