import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { FileRefRequest } from "../lib/fileRefRequest";
import {
  clampSessionFilesPanelWidth,
  stepSessionFilesPanelWidth,
  SESSION_FILES_WIDTH_STEP,
  type SessionFilesPanelBounds,
} from "../lib/sessionFilesPanel";
import type { SessionFilesPanelResize } from "../hooks/useSessionFilesPanelWidth";
import { FileBrowser } from "./FileBrowser";
import { CloseIcon, RefreshIcon } from "./icons";

export type SessionFilesPanelProps = {
  /** 選択中セッションの作業フォルダ (ワークスペース root 相対)。パネル / シートの root */
  root: string;
  /** アーカイブの除外名の実効値（app 状態）。行のダウンロードの出し分けに使う */
  excludeNames: readonly string[];
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
  excludeNames,
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
            : "flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-4 py-2"
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
      {/* compact の sheet は全画面 modal で、入力欄へドロップできない */}
      <FileBrowser
        root={root}
        reloadToken={reloadToken}
        excludeNames={excludeNames}
        openRequest={openRequest}
        onHandled={onHandled}
        canRef={!compact}
      />
    </>
  );
}

/** pointer capture 中の 1 回のドラッグ。move ごとの再描画を避けるため ref に持つ */
type ResizeDrag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  /** 最後に表示した幅 (終了経路で commit する値) */
  width: number;
};

/** ドラッグ中に body へ付けるクラス。styles/index.css がカーソルと選択抑止を持つ */
const RESIZING_CLASS = "is-resizing-panel";

/**
 * パネル左端に重ねる幅のハンドル。ドラッグ / ←→ / Home / End / ダブルクリックで幅を決める。
 * 幅の state は App 側が持つため、ここは表示の追従 (preview) と確定 (commit) を呼ぶだけ。
 */
function SessionFilesResizeHandle({
  width,
  min,
  max,
  preview,
  commit,
  reset,
}: Omit<SessionFilesPanelResize, "resizable">) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  const bounds: SessionFilesPanelBounds = { min, max };

  // 終了経路 (pointerup / pointercancel / lostpointercapture / unmount) をここへまとめる。
  // どの経路でもカーソルの解除・選択抑止の解除・aria-valuenow の確定を同じ処理で行う。
  // pointerId は「いま drag 中のポインター」だけを受け付ける (別の指の同時タッチで終わらせない)
  const finishDrag = (pointerId: number | null, commitWidth: boolean) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    document.body.classList.remove(RESIZING_CLASS);
    handleRef.current?.setAttribute("aria-valuenow", String(drag.width));
    // 移動ゼロのクリックは幅を選んだ操作ではないので、commit も保存もしない
    if (commitWidth && drag.width !== drag.startWidth) commit(drag.width);
  };

  // パネルが消える経路 (閉じる / セッション切替) でも、ドラッグ中の見た目と選択抑止を残さない
  useEffect(() => {
    return () => finishDrag(null, true);
  }, [commit]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 主ボタンだけで開始する。ドラッグ中の 2 本目のタッチでは開始し直さない
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
    document.body.classList.add(RESIZING_CLASS);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 開始幅からの絶対計算にする (clamp で端に貼り付いても、戻せば追従する)
    const next = clampSessionFilesPanelWidth(drag.startWidth - (event.clientX - drag.startX), bounds);
    drag.width = next;
    preview(next);
    // 読み上げの値も表示と同じタイミングで動かす (state へ入るのは終了時)
    handleRef.current?.setAttribute("aria-valuenow", String(next));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // ハンドルはパネルの左端にあるため、左へ動かす = 幅を増やす
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = event.key === "ArrowLeft" ? SESSION_FILES_WIDTH_STEP : -SESSION_FILES_WIDTH_STEP;
      event.preventDefault();
      commit(stepSessionFilesPanelWidth(width, delta, bounds));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      commit(event.key === "Home" ? min : max);
    }
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-label="セッションのファイルの幅"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      className="panel-resize-handle absolute inset-y-0 left-0 w-2 cursor-col-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-1 focus-visible:ring-focus focus-visible:ring-inset"
      onDoubleClick={reset}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={(event) => finishDrag(event.pointerId, true)}
      onPointerCancel={(event) => finishDrag(event.pointerId, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event.pointerId, true)}
    />
  );
}

/** 幅のハンドルを出す desktop の面だけが resize を受け取る (compact のシートは全画面で対象外) */
export type SessionFilesDesktopPanelProps = SessionFilesPanelProps & { resize: SessionFilesPanelResize };

/**
 * desktop のチャット右パネル。root の切替 (セッションの切替) は呼び出し側の key が mount ごとに
 * 入れ替える。幅が狭いので、ツリーとプレビューは FileBrowser 側のコンテナ判定で縦に積む。
 */
export function SessionFilesPanel({ resize, ...props }: SessionFilesDesktopPanelProps) {
  return (
    <aside
      aria-label="セッションのファイル"
      className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-line bg-panel"
    >
      {resize.resizable ? <SessionFilesResizeHandle {...resize} /> : null}
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
