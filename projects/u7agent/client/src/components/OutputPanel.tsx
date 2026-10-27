import { useMessageCopy } from "../hooks/useMessageCopy";
import { cn } from "../lib/cn";
import { CopyButton } from "./chat/CopyButton";

/**
 * 設定画面の「テスト」の出力。チャットのコードブロック (`md-code`) と同じ組み方の枠 1 枚に、
 * ヘッダ右のコピーを添える。成功 / 失敗は呼び出し側の 1 行が持ち、ここは枠と本文だけを持つ
 * (Card in Card を作らない)。
 */
export function OutputPanel({
  label,
  meta,
  text,
  mono = false,
  scroll = false,
  copyLabel,
}: {
  /** ヘッダ左の見出し (コードブロックの lang 名と同じ位置) */
  label: string;
  /** ヘッダの補足 (文字数など) */
  meta?: string;
  text: string;
  /** 本文を等幅で出す。ツール出力は true */
  mono?: boolean;
  /** 本文を枠内でスクロールさせる (長いツール出力) */
  scroll?: boolean;
  /** 右端のコピーの読み上げ名。省略するとコピーを出さない */
  copyLabel?: string;
}) {
  const { copiedId, copyMessage, copyFailure } = useMessageCopy();
  const copyId = "output";
  return (
    <div className="group/code overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line bg-soft py-0.5 pr-1.5 pl-2.5 text-3xs text-ink-faint">
        <span className="font-semibold">{label}</span>
        {meta ? <span className="text-ink-ghost">{meta}</span> : null}
        <span className="flex-1" />
        {copyLabel ? (
          <CopyButton
            copied={copiedId === copyId}
            failure={copyFailure(copyId)}
            onClick={() => void copyMessage(text, copyId)}
            label={copyLabel}
            reveal="code"
          />
        ) : null}
      </div>
      <pre
        className={cn(
          "m-0 px-2.5 py-2 break-words whitespace-pre-wrap",
          mono ? "font-mono text-1xs leading-relaxed" : "font-sans text-1sm leading-relaxed text-ink-strong",
          scroll ? "max-h-72 scrollbar-thin overflow-auto" : "",
        )}
      >
        {text}
      </pre>
    </div>
  );
}
