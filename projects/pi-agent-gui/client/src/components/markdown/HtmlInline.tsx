import { Fragment } from "react";
import type { ReactNode } from "react";
import type { HtmlNode } from "../../lib/markdown/types";

/**
 * 許可リストを通った生 HTML を React 要素へ写す唯一の層。
 * `innerHTML` / `dangerouslySetInnerHTML` を使わないため、本文由来の文字列がタグとして解釈される経路は無い。
 */
export function HtmlInline({ node }: { node: HtmlNode }) {
  return <>{renderNode(node)}</>;
}

function renderNodes(nodes: HtmlNode[]): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderNode(node)}</Fragment>);
}

function renderNode(node: HtmlNode): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "verbatim":
      // 許可外・不正な URL はタグごと原文を見せる (無言で消さない)
      return <code className="md-lit">{node.text}</code>;
    case "element":
      return renderElement(node.tag, node.attrs, node.children);
  }
}

function renderElement(
  tag: string,
  attrs: { href?: string; title?: string; src?: string; alt?: string },
  children: HtmlNode[],
): ReactNode {
  const content = renderNodes(children);
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
      return <img className="md-img" src={attrs.src} alt={attrs.alt ?? ""} title={attrs.title} />;
    default:
      return null;
  }
}
