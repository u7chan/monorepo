import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { resolveFileRefTarget, resolveLinkRefTarget, type FileRefTarget } from "../../lib/fileRef";
import type { FileRefOpenOutcome } from "../../lib/fileRefOpen";

export type FileRefOpener = {
  /** インラインコードの字面を面の種別つきで解決する (参照でなければ null) */
  resolve: (text: string) => FileRefTarget | null;
  /** Markdown リンクの href を解決する。規則が違う面 (スキル本文) は省略する (その面では横取りしない) */
  resolveLink?: (href: string) => FileRefTarget | null;
  /**
   * 実在を確認してから面を開く。origin は focus を戻す起点 (クリックした要素を渡す。
   * `document.activeElement` は当てにしない)。結果はクリック元が失敗理由を出すために返す。
   */
  open: (target: FileRefTarget, origin: HTMLElement | null) => Promise<FileRefOpenOutcome>;
};

const FileRefContext = createContext<FileRefOpener | null>(null);

export type FileRefProviderProps = {
  /** ワークスペース root の絶対パス (health.cwd)。未取得 ("") のときは絶対パスを解決しない */
  rootCwd: string;
  /** 選択中セッションの作業フォルダ (payload.cwd)。未確定 ("") のときは何も解決しない */
  cwd: string;
  onOpen: (target: FileRefTarget, origin: HTMLElement | null) => Promise<FileRefOpenOutcome>;
  children: ReactNode;
};

/**
 * assistant 本文のインラインコードからファイル参照を開く導線の context。
 * value は cwd と callback だけで作り、要求 seq やパネル開閉を混ぜない (過去の本文を再描画させない)。
 */
export function FileRefProvider({ rootCwd, cwd, onOpen, children }: FileRefProviderProps) {
  const value = useMemo<FileRefOpener>(
    () => ({
      resolve: (text: string) => resolveFileRefTarget(text, rootCwd, cwd),
      resolveLink: (href: string) => resolveLinkRefTarget(href, rootCwd, cwd),
      open: onOpen,
    }),
    [rootCwd, cwd, onOpen],
  );
  return <FileRefContext.Provider value={value}>{children}</FileRefContext.Provider>;
}

/**
 * 解決規則が面ごとに違うとき (スキル本文の参照は skill dir 基準) に、解決関数ごと渡す。
 * 値は呼び出し側で memo する (本文の再描画を招かないため)。
 */
export function FileRefOpenerProvider({ value, children }: { value: FileRefOpener; children: ReactNode }) {
  return <FileRefContext.Provider value={value}>{children}</FileRefContext.Provider>;
}

/**
 * クリック元が持つ「確認中 / 失敗」の状態。後着の応答を捨てる規則は、インラインコードとリンクで共通にする。
 */
function useFileRefAction(opener: FileRefOpener | null, target: FileRefTarget | null) {
  const [state, setState] = useState<"idle" | "checking" | "failed">("idle");
  const [failure, setFailure] = useState("");
  const clickRef = useRef(0);
  const open = (origin: HTMLElement) => {
    if (opener === null || target === null) return;
    const click = (clickRef.current += 1);
    setState("checking");
    setFailure("");
    void opener.open(target, origin).then((outcome) => {
      // 同じ参照を続けて押したときは、古い応答で新しい表示を戻さない
      if (click !== clickRef.current) return;
      setState(outcome.kind === "failed" ? "failed" : "idle");
      setFailure(outcome.kind === "failed" ? outcome.message : "");
    });
  };
  return { checking: state === "checking", failure, open };
}

/** 参照にならない字面と provider の外 (設定ページの再利用など) は従来どおりのインラインコードにする */
export function InlineFileRef({ text }: { text: string }) {
  const opener = useContext(FileRefContext);
  const target = opener === null ? null : opener.resolve(text);
  const action = useFileRefAction(opener, target);
  if (opener === null || target === null) return <code>{text}</code>;
  return (
    // 参照とその失敗理由を 1 つの span にまとめる (段落の中で理由が別の参照に属して見えないようにする)
    <span>
      <button
        type="button"
        className="md-fileref"
        title={target.kind === "skill" ? "スキルで開く" : "作業フォルダで開く"}
        aria-busy={action.checking}
        onClick={(event) => action.open(event.currentTarget)}
      >
        <code>{text}</code>
      </button>
      {action.failure === "" ? null : <span className="md-fileref-note">{action.failure}</span>}
    </span>
  );
}

/**
 * 作業フォルダ / スキルのファイルを指す Markdown リンクを、インラインコードと同じ導線で開く。
 * 解決できない href は従来どおりのリンクのままにする (一般の相対 Web リンクを横取りしないため)。
 */
export function MarkdownLink({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  const opener = useContext(FileRefContext);
  const target = opener?.resolveLink?.(href) ?? null;
  const action = useFileRefAction(opener, target);
  if (target === null) {
    return (
      <a href={href} title={title} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    // 理由をリンクの近くへ添えるため、リンクと同じインラインに包む
    <span>
      <a
        href={href}
        title={title ?? (target.kind === "skill" ? "スキルで開く" : "作業フォルダで開く")}
        className="md-filelink"
        aria-busy={action.checking}
        onClick={(event) => {
          // href の遷移先はアプリ origin の 404 になる (拡張子つきのパスは SPA へフォールバックしない)
          event.preventDefault();
          action.open(event.currentTarget);
        }}
      >
        {children}
      </a>
      {action.failure === "" ? null : <span className="md-fileref-note">{action.failure}</span>}
    </span>
  );
}
