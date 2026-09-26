import { memo, useMemo } from "react";
import { parseInline } from "../../lib/markdown/inline";
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "../../lib/markdown/parse";
import type { MdAlign, MdBlock, MdHeadingLevel, MdInline, MdListItem } from "../../lib/markdown/types";
import { ZoomableImage } from "../ImageZoom";
import { CodeBlock } from "./CodeBlock";
import { Diagram } from "./Diagram";
import { InlineFileRef } from "./FileRefLink";
import { HtmlInline } from "./HtmlInline";
import { MathBlock, MathInline } from "./MathView";

/**
 * assistant 本文の Markdown 描画の入口。
 * 巨大な本文は解析せずプレーン表示に落とし、ストリーミング中の再解析コストを抑える。
 */
export function MarkdownView({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_LENGTH) return <div className="md whitespace-pre-wrap">{text}</div>;
  return <MarkdownBlocks text={text} />;
}

/** ブロック列を描く。text (文字列) が変わらない間は中の解析をやり直さない */
export const MarkdownBlocks = memo(function MarkdownBlocks({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <MdBlockView key={index} block={block} />
      ))}
    </div>
  );
});

/** 同じ内容のブロックは再描画しない (ストリーミングでは末尾のブロックだけが変わる) */
const MdBlockView = memo(
  function MdBlockView({ block }: { block: MdBlock }) {
    switch (block.kind) {
      case "heading":
        return <MdHeading level={block.level} source={block.source} />;
      case "paragraph":
        return <MdParagraph source={block.source} />;
      case "code":
        // 図はフェンスが閉じてから描画する (未完成の本文でレイアウトを走らせない)
        return block.lang?.toLowerCase() === "mermaid" && block.closed ? (
          <Diagram text={block.text} />
        ) : (
          <CodeBlock lang={block.lang} text={block.text} closed={block.closed} />
        );
      case "list":
        return <MdList ordered={block.ordered} start={block.start} items={block.items} />;
      case "quote":
        return <MdQuote source={block.source} />;
      case "table":
        return <MdTable align={block.align} header={block.header} rows={block.rows} />;
      case "math":
        return <MathBlock text={block.text} source={block.source} />;
      case "hr":
        return <hr className="md-hr" />;
    }
  },
  (prev, next) => blocksEqual(prev.block, next.block),
);

const MdParagraph = memo(function MdParagraph({ source }: { source: string }) {
  return (
    <p>
      <MdInlineSource source={source} />
    </p>
  );
});

const MdHeading = memo(function MdHeading({ level, source }: { level: MdHeadingLevel; source: string }) {
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag>
      <MdInlineSource source={source} />
    </Tag>
  );
});

const MdQuote = memo(function MdQuote({ source }: { source: string }) {
  return (
    <blockquote>
      <MarkdownBlocks text={source} />
    </blockquote>
  );
});

const MdList = memo(
  function MdList({ ordered, start, items }: { ordered: boolean; start: number; items: MdListItem[] }) {
    const content = items.map((item, index) => <MdListItemView key={index} item={item} />);
    return ordered ? <ol start={start}>{content}</ol> : <ul>{content}</ul>;
  },
  (prev, next) => prev.ordered === next.ordered && prev.start === next.start && listItemsEqual(prev.items, next.items),
);

const MdListItemView = memo(
  function MdListItemView({ item }: { item: MdListItem }) {
    if (item.task === null)
      return (
        <li>
          <MarkdownBlocks text={item.source} />
        </li>
      );
    return (
      <li className="md-task">
        <input className="md-check" type="checkbox" checked={item.task} readOnly />
        <MarkdownBlocks text={item.source} />
      </li>
    );
  },
  (prev, next) => prev.item.task === next.item.task && prev.item.source === next.item.source,
);

const MdTable = memo(
  function MdTable({ align, header, rows }: { align: MdAlign[]; header: string[]; rows: string[][] }) {
    return (
      <div className="md-table-wrap scrollbar-thin">
        <table className="md-table">
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index} className={`md-al-${align[index] ?? "left"}`}>
                  <MdInlineSource source={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={`md-al-${align[cellIndex] ?? "left"}`}>
                    <MdInlineSource source={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
  (prev, next) => prev.align.join(",") === next.align.join(",") && tableEqual(prev, next),
);

/** source (インライン記法を含む文字列) が同じ間は解析し直さない */
const MdInlineSource = memo(function MdInlineSource({ source }: { source: string }) {
  const nodes = useMemo(() => parseInline(source), [source]);
  return <InlineNodes nodes={nodes} />;
});

/** inLink はリンクの内側を辿る印。`` [`x`](url) `` の code を操作要素にしないために子へ通す */
function InlineNodes({ nodes, inLink = false }: { nodes: MdInline[]; inLink?: boolean }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} inLink={inLink} />
      ))}
    </>
  );
}

function InlineNode({ node, inLink = false }: { node: MdInline; inLink?: boolean }) {
  switch (node.kind) {
    case "text":
      return node.text;
    case "break":
      return <br />;
    case "literal":
      // 解析できなかった記法は消さずに等幅で見せる
      return <code className="md-lit">{node.text}</code>;
    case "code":
      // <a> の中に button を入れない (リンクの children は従来どおり code として描く)
      return inLink ? <code>{node.text}</code> : <InlineFileRef text={node.text} />;
    case "strong":
      return (
        <strong>
          <InlineNodes nodes={node.children} inLink={inLink} />
        </strong>
      );
    case "em":
      return (
        <em>
          <InlineNodes nodes={node.children} inLink={inLink} />
        </em>
      );
    case "del":
      return (
        <del>
          <InlineNodes nodes={node.children} inLink={inLink} />
        </del>
      );
    case "link":
      return (
        <a href={node.href} title={node.title ?? undefined} target="_blank" rel="noreferrer noopener">
          <InlineNodes nodes={node.children} inLink />
        </a>
      );
    case "image":
      // <a> の中に button を置けない。リンクの children は従来どおり素の img で描く
      return inLink ? (
        <img className="md-img" src={node.src} alt={node.alt} />
      ) : (
        <ZoomableImage src={node.src} alt={node.alt} variant="markdown" />
      );
    case "html":
      return <HtmlInline node={node.node} inLink={inLink} />;
    case "math":
      return <MathInline node={node.node} />;
  }
}

function blocksEqual(a: MdBlock, b: MdBlock): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "heading" && b.kind === "heading") return a.level === b.level && a.source === b.source;
  if (a.kind === "paragraph" && b.kind === "paragraph") return a.source === b.source;
  if (a.kind === "quote" && b.kind === "quote") return a.source === b.source;
  if (a.kind === "math" && b.kind === "math") return a.text === b.text && a.source === b.source;
  if (a.kind === "hr" && b.kind === "hr") return true;
  if (a.kind === "code" && b.kind === "code") return a.lang === b.lang && a.text === b.text && a.closed === b.closed;
  if (a.kind === "list" && b.kind === "list") {
    return a.ordered === b.ordered && a.start === b.start && listItemsEqual(a.items, b.items);
  }
  if (a.kind === "table" && b.kind === "table") {
    return a.align.join(",") === b.align.join(",") && tableEqual(a, b);
  }
  return false;
}

/** 比較は文字列の突き合わせだけで済ませる (再解析より遥かに安い) */
function tableEqual(a: { header: string[]; rows: string[][] }, b: { header: string[]; rows: string[][] }): boolean {
  if (a.header.join("\u0000") !== b.header.join("\u0000")) return false;
  if (a.rows.length !== b.rows.length) return false;
  return a.rows.every((row, index) => row.join("\u0000") === b.rows[index].join("\u0000"));
}

function listItemsEqual(a: MdListItem[], b: MdListItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item.task === b[index].task && item.source === b[index].source);
}
