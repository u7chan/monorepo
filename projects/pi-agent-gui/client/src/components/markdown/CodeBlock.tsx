import { memo, useMemo } from "react";
import { useMessageCopy } from "../../hooks/useMessageCopy";
import { highlightCode } from "../../lib/markdown/highlight";
import { CopyButton, REVEAL_CODE } from "../chat/CopyButton";

/**
 * コードフェンスの描画。ハイライトは文字列 props で memo 化され、伸びているブロックだけを再計算する。
 */
export const CodeBlock = memo(function CodeBlock({
  lang,
  text,
  closed,
}: {
  lang: string | null;
  text: string;
  closed: boolean;
}) {
  const tokens = useMemo(() => highlightCode(text, lang), [text, lang]);
  const { copiedId, copyMessage } = useMessageCopy();
  const lineCount = text.trim() === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  return (
    <figure className={["md-code group/code", closed ? "" : "md-code-streaming"].filter(Boolean).join(" ")}>
      <figcaption className="md-code-head">
        <span className="md-code-lang">{lang ?? "text"}</span>
        {lineCount > 0 ? <span className="md-code-lines">{lineCount} 行</span> : null}
        <span className="md-code-grow" />
        {closed ? (
          <CopyButton
            copied={copiedId === "code"}
            onClick={() => void copyMessage(text, "code")}
            label="コードをコピー"
            revealClass={REVEAL_CODE}
          />
        ) : (
          <span className="md-code-state">生成中…</span>
        )}
      </figcaption>
      <pre className="md-code-body scrollbar-thin">
        <code>
          {tokens === null
            ? text
            : tokens.map((token, index) =>
                token.kind === "plain" ? token.text : (
                  <span key={index} className={`tok-${token.kind}`}>
                    {token.text}
                  </span>
                ),
              )}
          {closed ? null : <span className="md-caret" aria-hidden="true" />}
        </code>
      </pre>
    </figure>
  );
});
