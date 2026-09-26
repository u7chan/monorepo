import { Fragment } from "react";
import type { ReactNode } from "react";
import type { HtmlNode } from "../../lib/markdown/types";
import { ZoomableImage } from "../ImageZoom";

/**
 * 許可リストを通った生 HTML を React 要素へ写す唯一の層。
 * `innerHTML` / `dangerouslySetInnerHTML` を使わないため、本文由来の文字列がタグとして解釈される経路は無い。
 */
export function HtmlInline({ node, inLink = false }: { node: HtmlNode; inLink?: boolean }) {
  return <>{renderNode(node, inLink)}</>;
}

function renderNodes(nodes: HtmlNode[], inLink: boolean): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderNode(node, inLink)}</Fragment>);
}

function renderNode(node: HtmlNode, inLink: boolean): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "verbatim":
      // 許可外・不正な URL はタグごと原文を見せる (無言で消さない)
      return <code className="md-lit">{node.text}</code>;
    case "element":
      return renderElement(node.tag, node.attrs, node.children, inLink);
  }
}

function renderElement(
  tag: string,
  attrs: { href?: string; title?: string; src?: string; alt?: string },
  children: HtmlNode[],
  inLink: boolean,
): ReactNode {
  // Markdown のリンクはラベルに生 HTML を書ける ([<img src="…">](url)) ため、
  // <a> の子へも印を伝搬させる (<a> の中の button を防ぐ)
  const link = inLink || tag === "a";
  const content = renderNodes(children, link);
  switch (tag) {
    case "b":
    case "strong":
      return <strong>{content}</strong>;
    case "i":
    case "em":
      return <em>{content}</em>;
    case "u":
      return <u>{content}</u>;
    case "s":
    case "del":
      return <del>{content}</del>;
    case "ins":
      return <ins>{content}</ins>;
    case "code":
      return <code>{content}</code>;
    case "kbd":
      return <kbd>{content}</kbd>;
    case "mark":
      return <mark>{content}</mark>;
    case "small":
      return <small>{content}</small>;
    case "sub":
      return <sub>{content}</sub>;
    case "sup":
      return <sup>{content}</sup>;
    case "span":
      return <span>{content}</span>;
    case "a":
      return (
        <a href={attrs.href} title={attrs.title} target="_blank" rel="noreferrer noopener">
          {content}
        </a>
      );
    case "br":
      return <br />;
    case "hr":
      return <hr className="md-hr" />;
    case "img":
      // リンクの中の画像はリンクとして動かす (button を入れない)
      return inLink ? (
        <img className="md-img" src={attrs.src} alt={attrs.alt ?? ""} title={attrs.title} />
      ) : (
        <ZoomableImage src={attrs.src ?? ""} alt={attrs.alt ?? ""} title={attrs.title} variant="markdown" />
      );
    default:
      return null;
  }
}
