import { useEffect, useRef, useState } from "react";
import { isRunEnd } from "../lib/sessionFiles";
import type { RunStatus } from "../types";
import { FileBrowser } from "./FileBrowser";
import { CloseIcon, RefreshIcon } from "./icons";

export type SessionFilesPanelProps = {
  /** 選択中セッションの作業フォルダ (ワークスペース root 相対)。パネルの root */
  root: string;
  /** 実行状態。実行中から抜けた遷移で一覧と開いている本文を 1 回取り直す */
  runStatus: RunStatus;
  onClose: () => void;
};

/**
 * チャットの右パネル。選択中セッションの作業フォルダを `FileBrowser` で見る。desktop のチャット画面だけに
 * 出し、root の切替 (セッションの切替) は呼び出し側の `key` が mount ごとに入れ替える。
 * 幅が狭いので、ツリーとプレビューは `FileBrowser` 側のコンテナ判定が縦に積む。
 */
export function SessionFilesPanel({ root, runStatus, onClose }: SessionFilesPanelProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const previousRunStatusRef = useRef(runStatus);

  // ラン終了で 1 回だけ取り直す。実行中は書き込みが続くため、途中の再取得は挟まない
  useEffect(() => {
    const previous = previousRunStatusRef.current;
    previousRunStatusRef.current = runStatus;
    if (isRunEnd(previous, runStatus)) setReloadToken((token) => token + 1);
  }, [runStatus]);

  return (
    <aside
      aria-label="セッションのファイル"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-line bg-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 basis-36 truncate text-xs font-semibold text-ink-strong">セッションのファイル</h2>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setReloadToken((token) => token + 1)} className="btn-quiet">
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
