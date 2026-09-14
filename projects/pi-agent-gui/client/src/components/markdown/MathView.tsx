import { Fragment, memo, useMemo } from "react";
import { parseLatex } from "../../lib/markdown/latex";
import { toMathLayout } from "../../lib/markdown/latexLayout";
import type { MathLayout } from "../../lib/markdown/latexLayout";
import type { MathNode } from "../../lib/markdown/types";

/**
 * 数式の描画。レイアウトは lib 側のモデルが持ち、ここは CSS クラスへ写すだけにする。
 * 本番の CSP は style-src 'self' のため、インライン style は使わない。
 */

/** インライン数式。解析済みの木を受け取るので再解析しない */
export const MathInline = memo(function MathInline({ node }: { node: MathNode }) {
  const layout = useMemo(() => toMathLayout(node), [node]);
  return (
    <span className="math-inline">
      <MathLayoutView layout={layout} />
    </span>
  );
});

/** ディスプレイ数式。解析に失敗したら区切りを含む原文を等幅で出す (例外は投げない) */
export const MathBlock = memo(function MathBlock({ text, source }: { text: string; source: string }) {
  const layout = useMemo(() => {
    const parsed = parseLatex(text);
    return parsed.ok ? toMathLayout(parsed.node) : null;
  }, [text]);
  if (layout === null) {
    // 解析できなかった数式は区切りごと原文に戻す。改行は原文の形を保って見せる
    const lines = source.split("\n");
    return (
      <p>
        <code className="md-lit">
          {lines.map((line, index) => (
            <Fragment key={index}>
              {index === 0 ? null : <br />}
              {line}
            </Fragment>
          ))}
        </code>
      </p>
    );
  }
  return (
    <div className="math-block scrollbar-thin">
      <MathLayoutView layout={layout} />
    </div>
  );
});

function MathLayoutView({ layout }: { layout: MathLayout }) {
  switch (layout.kind) {
    case "row":
      return (
        <>
          {layout.children.map((child, index) => (
            <MathLayoutView key={index} layout={child} />
          ))}
        </>
      );
    case "atom":
      return <span className={layout.cls}>{layout.text}</span>;
    case "space":
      return <span className={layout.cls} />;
    case "empty":
      return null;
    case "frac":
      return (
        <span className="frac">
          <span className="num">
            <MathLayoutView layout={layout.num} />
          </span>
          <span className="den">
            <MathLayoutView layout={layout.den} />
          </span>
        </span>
      );
    case "sqrt":
      return (
        <span className="sqrt">
          {layout.index === null ? null : (
            <span className="idx">
              <MathLayoutView layout={layout.index} />
            </span>
          )}
          <span className="radical">√</span>
          <span className="rad">
            <MathLayoutView layout={layout.body} />
          </span>
        </span>
      );
    case "bigop":
      return (
        <span className={layout.word ? "bigop bigop-word" : "bigop"}>
          {layout.upper === null ? null : (
            <span className="top">
              <MathLayoutView layout={layout.upper} />
            </span>
          )}
          <span className="glyph">{layout.glyph}</span>
          {layout.lower === null ? null : (
            <span className="bot">
              <MathLayoutView layout={layout.lower} />
            </span>
          )}
        </span>
      );
    case "script":
      return (
        <>
          <MathLayoutView layout={layout.base} />
          {layout.sup === null ? null : (
            <sup>
              <MathLayoutView layout={layout.sup} />
            </sup>
          )}
          {layout.sub === null ? null : (
            <sub>
              <MathLayoutView layout={layout.sub} />
            </sub>
          )}
        </>
      );
    case "fenced":
      return (
        <span className="matrix">
          {layout.open === null ? null : <MathLayoutView layout={layout.open} />}
          <MathLayoutView layout={layout.body} />
          {layout.close === null ? null : <MathLayoutView layout={layout.close} />}
        </span>
      );
    case "delim":
      return <span className={`delim delim-${layout.scale}`}>{layout.text}</span>;
    case "matrix":
      return (
        <span className="matrix">
          {layout.open === null ? null : <MathLayoutView layout={layout.open} />}
          <span className={`${layout.cls} mgc${layout.columns}`}>
            {layout.cells.map((cell, index) => (
              <span key={index}>
                <MathLayoutView layout={cell} />
              </span>
            ))}
          </span>
          {layout.close === null ? null : <MathLayoutView layout={layout.close} />}
        </span>
      );
  }
}
