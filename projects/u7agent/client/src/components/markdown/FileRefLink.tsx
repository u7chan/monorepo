import { createContext, useContext, useMemo, type ReactNode } from "react";
import { resolveFileRef } from "../../lib/fileRef";

export type FileRefOpener = {
  /** インラインコードの字面を cwd 相対のパスへ解決する (参照でなければ null) */
  resolve: (text: string) => string | null;
  /** origin は focus を戻す起点。クリックした要素を渡す (document.activeElement は当てにしない) */
  open: (path: string, origin: HTMLElement | null) => void;
};

const FileRefContext = createContext<FileRefOpener | null>(null);

export type FileRefProviderProps = {
  /** ワークスペース root の絶対パス (health.cwd)。未取得 ("") のときは絶対パスを解決しない */
  rootCwd: string;
  /** 選択中セッションの作業フォルダ (payload.cwd)。未確定 ("") のときは何も解決しない */
  cwd: string;
  onOpen: (path: string, origin: HTMLElement | null) => void;
  children: ReactNode;
};

/**
 * assistant 本文のインラインコードからファイル参照を開く導線の context。
 * value は cwd と callback だけで作り、要求 seq やパネル開閉を混ぜない (過去の本文を再描画させない)。
 */
export function FileRefProvider({ rootCwd, cwd, onOpen, children }: FileRefProviderProps) {
  const value = useMemo<FileRefOpener>(
    () => ({ resolve: (text: string) => resolveFileRef(text, rootCwd, cwd), open: onOpen }),
    [rootCwd, cwd, onOpen],
  );
  return <FileRefContext.Provider value={value}>{children}</FileRefContext.Provider>;
}

/** 参照にならない字面と provider の外 (設定ページの再利用など) は従来どおりのインラインコードにする */
export function InlineFileRef({ text }: { text: string }) {
  const opener = useContext(FileRefContext);
  const path = opener === null ? null : opener.resolve(text);
  if (opener === null || path === null) return <code>{text}</code>;
  return (
    <button
      type="button"
      className="md-fileref"
      title="作業フォルダで開く"
      onClick={(event) => opener.open(path, event.currentTarget)}
    >
      <code>{text}</code>
    </button>
  );
}
