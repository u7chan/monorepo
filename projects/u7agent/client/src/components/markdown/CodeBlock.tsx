import { memo, useMemo } from "react";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { cn } from "../../lib/cn";
import { codeLineCount, lineNumbers } from "../../lib/codeLines";
import { highlightCode } from "../../lib/markdown/highlight";
import { CopyButton } from "../chat/CopyButton";

/**
 * コードフェンスの描画。ハイライトは文字列 props で memo 化され、伸びているブロックだけを再計算する。
 * 行番号は本文と同じ行送りの別列に出し、コピーにも選択にも入れない (docs/markdown.md#コードブロックの行番号)。
 * note は呼び出し側が理由を 1 行添えるためのもの (未対応記法を原文表示に落とすときなど)。
 */
export const CodeBlock = memo(function CodeBlock({
  lang,
  text,
  closed,
  note,
}: {
  lang: string | null;
  text: string;
  closed: boolean;
  note?: string;
}) {
  const tokens = useMemo(() => highlightCode(text, lang), [text, lang]);
  const { copiedId, copyMessage } = useMessageCopy();
  const lineCount = codeLineCount(text);
  return (
    <figure className={cn("md-code group/code", closed ? "" : "md-code-streaming")}>
      <figcaption className="md-code-head">
        <span className="md-code-lang">{lang ?? "text"}</span>
        {lineCount > 0 ? <span className="md-code-lines">{lineCount} 行</span> : null}
        <span className="md-code-grow" />
        {closed ? (
          <CopyButton
            copied={copiedId === "code"}
            onClick={() => void copyMessage(text, "code")}
            label="コードをコピー"
            reveal="code"
          />
        ) : (
          <span className="md-code-state">生成中…</span>
        )}
      </figcaption>
      <div className="md-code-body scrollbar-thin font-mono">
        <div className="md-code-row">
          {lineCount === 0 ? null : (
            <div aria-hidden="true" className="md-code-gutter">
              {lineNumbers(lineCount)}
            </div>
          )}
          <pre className="md-code-pre">
            <code>
              {tokens === null
                ? text
                : tokens.map((token, index) =>
                    token.kind === "plain" ? (
                      token.text
                    ) : (
                      <span key={index} className={`tok-${token.kind}`}>
                        {token.text}
                      </span>
                    ),
                  )}
              {closed ? null : <span className="md-caret" aria-hidden="true" />}
            </code>
          </pre>
        </div>
      </div>
      {note === undefined ? null : (
        <div className="border-t border-dashed border-line px-3 pt-1 pb-2 text-1xs text-warn">{note}</div>
      )}
    </figure>
  );
});
