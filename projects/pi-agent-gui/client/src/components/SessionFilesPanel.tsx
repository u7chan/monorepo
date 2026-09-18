import { useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { CloseIcon, RefreshIcon } from "./icons";

export type SessionFilesPanelProps = {
  /** 選択中セッションの作業フォルダ (ワークスペース root 相対)。パネルの root */
  root: string;
  /** run が終わった回数 (ChatState.runEndSeq)。増えるたびに一覧と開いている本文を取り直す */
  runEndSeq: number;
  onClose: () => void;
};

/**
 * チャットの右パネル。選択中セッションの作業フォルダを `FileBrowser` で見る。desktop のチャット画面だけに
 * 出し、root の切替 (セッションの切替) は呼び出し側の `key` が mount ごとに入れ替える。
 * 幅が狭いので、ツリーとプレビューは `FileBrowser` 側のコンテナ判定が縦に積む。
 */
export function SessionFilesPanel({ root, runEndSeq, onClose }: SessionFilesPanelProps) {
  const [manualReload, setManualReload] = useState(0);
  // ヘッダの「再読み込み」と run_end を 1 つの token にまとめる。どちらも単調なので、合計が
  // 変わったときだけ取り直す。描画間の runStatus の差は使わない (run_start と run_end が同じ
  // バッチで届くと running を観測できず、run_end を取りこぼす。カウンタは reducer が進める)
  const reloadToken = manualReload + runEndSeq;

  return (
    <aside
      aria-label="セッションのファイル"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-line bg-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 basis-36 truncate text-xs font-semibold text-ink-strong">セッションのファイル</h2>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setManualReload((count) => count + 1)} className="btn-quiet">
            <RefreshIcon />
            再読み込み
          </button>
          <button type="button" onClick={onClose} aria-label="閉じる" title="閉じる" className="btn-quiet px-2.5">
            <CloseIcon />
          </button>
        </div>
      </header>
      <FileBrowser root={root} reloadToken={reloadToken} />
    </aside>
  );
}
