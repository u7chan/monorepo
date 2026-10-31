import { memo, useMemo } from "react";
import { parseInline } from "../../lib/markdown/inline";
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "../../lib/markdown/parse";
import type { MdAlign, MdBlock, MdHeadingLevel, MdInline, MdListItem } from "../../lib/markdown/types";
import { ZoomableImage } from "../ImageZoom";
import { GenerationCaption } from "../GenerationCaption";
import { CodeBlock } from "./CodeBlock";
import { Diagram } from "./Diagram";
import { InlineFileRef, MarkdownLink } from "./FileRefLink";
import { HtmlInline } from "./HtmlInline";
import { useMarkdownImageCaption, useMarkdownImageResolution } from "./MarkdownImageRefs";
import { MathBlock, MathInline } from "./MathView";

/**
 * チャット本文とファイルプレビューの Markdown 描画の入口。
 * 巨大な本文は解析せずプレーン表示に落とし、1 回の描画で走る再解析のコストを抑える。
 */
export function MarkdownView({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_LENGTH) return <div className="md whitespace-pre-wrap">{text}</div>;
  return <MarkdownBlocks text={text} />;
}

/** ブロック列を描く。text (文字列) が変わらない間は中の解析をやり直さない */
export const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
  caption = true,
}: {
  text: string;
  /** 段落の中の画像にキャプションを出せる場所か (見出し / 表のセル / 引用は false で渡す) */
  caption?: boolean;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <MdBlockView key={index} block={block} caption={caption} />
      ))}
    </div>
  );
});

/** 同じ内容のブロックは再描画しない (ストリーミングでは末尾のブロックだけが変わる) */
const MdBlockView = memo(
  function MdBlockView({ block, caption = true }: { block: MdBlock; caption?: boolean }) {
    switch (block.kind) {
      case "heading":
        return <MdHeading level={block.level} source={block.source} />;
      case "paragraph":
        return <MdParagraph source={block.source} caption={caption} />;
      case "code":
        // 図はフェンスが閉じてから描画する (未完成の本文でレイアウトを走らせない)
        return block.lang?.toLowerCase() === "mermaid" && block.closed ? (
          <Diagram text={block.text} />
        ) : (
          <CodeBlock lang={block.lang} text={block.text} closed={block.closed} />
        );
      case "list":
        return <MdList ordered={block.ordered} start={block.start} items={block.items} caption={caption} />;
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
  (prev, next) => prev.caption === next.caption && blocksEqual(prev.block, next.block),
);

const MdParagraph = memo(function MdParagraph({ source, caption = true }: { source: string; caption?: boolean }) {
  return (
    <p>
      <MdInlineSource source={source} caption={caption} />
    </p>
  );
});

const MdHeading = memo(function MdHeading({ level, source }: { level: MdHeadingLevel; source: string }) {
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag>
      {/* 見出しの中の画像にはキャプションを出さない */}
      <MdInlineSource source={source} caption={false} />
    </Tag>
  );
});

const MdQuote = memo(function MdQuote({ source }: { source: string }) {
  return (
    <blockquote>
      {/* 引用の中の段落にはキャプションを出さない (MarkdownBlocks を再帰的に呼ぶため印を渡す) */}
      <MarkdownBlocks text={source} caption={false} />
    </blockquote>
  );
});

const MdList = memo(
  function MdList({
    ordered,
    start,
    items,
    caption = true,
  }: {
    ordered: boolean;
    start: number;
    items: MdListItem[];
    caption?: boolean;
  }) {
    const content = items.map((item, index) => <MdListItemView key={index} item={item} caption={caption} />);
    return ordered ? <ol start={start}>{content}</ol> : <ul>{content}</ul>;
  },
  (prev, next) =>
    prev.caption === next.caption &&
    prev.ordered === next.ordered &&
    prev.start === next.start &&
    listItemsEqual(prev.items, next.items),
);

const MdListItemView = memo(
  function MdListItemView({ item, caption = true }: { item: MdListItem; caption?: boolean }) {
    if (item.task === null)
      return (
        <li>
          <MarkdownBlocks text={item.source} caption={caption} />
        </li>
      );
    return (
      <li className="md-task">
        <input className="md-check" type="checkbox" checked={item.task} readOnly />
        <MarkdownBlocks text={item.source} caption={caption} />
      </li>
    );
  },
  (prev, next) =>
    prev.caption === next.caption && prev.item.task === next.item.task && prev.item.source === next.item.source,
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
                  {/* 表のセルの中の画像にはキャプションを出さない */}
                  <MdInlineSource source={cell} caption={false} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={`md-al-${align[cellIndex] ?? "left"}`}>
                    <MdInlineSource source={cell} caption={false} />
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
const MdInlineSource = memo(function MdInlineSource({
  source,
  inLink = false,
  caption = true,
}: {
  source: string;
  inLink?: boolean;
  caption?: boolean;
}) {
  const nodes = useMemo(() => parseInline(source), [source]);
  return <InlineNodes nodes={nodes} inLink={inLink} caption={caption} />;
});

/** inLink はリンクの内側を辿る印。`` [`x`](url) `` の code を操作要素にしないために子へ通す */
function InlineNodes({
  nodes,
  inLink = false,
  caption = true,
}: {
  nodes: MdInline[];
  inLink?: boolean;
  caption?: boolean;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} inLink={inLink} caption={caption} />
      ))}
    </>
  );
}

function InlineNode({ node, inLink = false, caption = true }: { node: MdInline; inLink?: boolean; caption?: boolean }) {
  // 画像 src だけ cwd 相対から配信 URL へ解決する (provider が無ければ入力をそのまま使う)
  const resolution = useMarkdownImageResolution(node.kind === "image" ? node.src : "");
  // キャプションは解決できた画像にだけ付け、リンクの中とキャプションの対象外の場所では引かない
  const info = useMarkdownImageCaption(caption && !inLink && node.kind === "image" ? (resolution?.path ?? null) : null);
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
          <InlineNodes nodes={node.children} inLink={inLink} caption={caption} />
        </strong>
      );
    case "em":
      return (
        <em>
          <InlineNodes nodes={node.children} inLink={inLink} caption={caption} />
        </em>
      );
    case "del":
      return (
        <del>
          <InlineNodes nodes={node.children} inLink={inLink} caption={caption} />
        </del>
      );
    case "link":
      return (
        <MarkdownLink href={node.href} title={node.title ?? undefined}>
          <InlineNodes nodes={node.children} inLink caption={caption} />
        </MarkdownLink>
      );
    case "image": {
      const imageSrc = resolution?.src ?? node.src;
      // <a> の中に button を置けない。リンクの children は従来どおり素の img で描く
      const image = inLink ? (
        <img className="md-img" src={imageSrc} alt={node.alt} />
      ) : (
        <ZoomableImage src={imageSrc} alt={node.alt} variant="markdown" />
      );
      if (info === undefined) return image;
      // 画像は段落 (<p>) の中に出るため figure / figcaption は使えない。block の span で包み、
      // 画像の前後で行が分かれる見た目を変えない
      return (
        <span className="block">
          {image}
          <GenerationCaption info={info} />
        </span>
      );
    }
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
