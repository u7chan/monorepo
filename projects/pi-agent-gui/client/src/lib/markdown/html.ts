/**
 * 生 HTML のトークン化と許可リスト判定。`innerHTML` / `DOMParser` は使わず、
 * 許可したタグだけを React 要素へ写せる木 (HtmlNode) にする。
 */
import type { HtmlAttrs, HtmlNode, HtmlTag } from "./types";

const ALLOWED_TAGS = new Set<string>([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "code",
  "kbd",
  "mark",
  "small",
  "sub",
  "sup",
  "span",
  "a",
  "br",
  "hr",
  "img",
]);

const VOID_TAGS = new Set<string>(["br", "hr", "img"]);

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/** タグ 1 つの上限。壊れた入力で `<` から延々と探し続けないための保険 */
const MAX_TAG_LENGTH = 2048;

/** 入れ子の上限。ここを超える入れ子はタグごと原文に落とし、再帰でスタックを食い潰さない */
const MAX_HTML_DEPTH = 8;

/** 1 回の解析で HTML を走査する文字数の上限。閉じないタグが大量にある入力で指数的に走査しないための保険 */
export type HtmlBudget = { steps: number };

/** 相対パスと http / https / mailto だけを通す。画像は同一オリジン (= 相対パス) のみ */
export function safeUrl(raw: string, kind: "link" | "image"): string | null {
  const value = raw.trim().replace(/&amp;/g, "&");
  if (value === "") return null;
  // 制御文字・空白・バックスラッシュを含む URL は解釈しない (ブラウザごとの解釈揺れを避ける)
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (scheme !== null) {
    if (!SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
    // 外部の画像は CSP (default-src 'self') で読み込めないので描画しない
    return kind === "image" ? null : value;
  }
  // プロトコル相対 (//host) は外部オリジンになり得るため通さない
  if (value.startsWith("//")) return null;
  return value;
}

type RawTag = {
  closing: boolean;
  tag: string;
  attrs: HtmlAttrs;
  selfClosing: boolean;
  /** タグの終端 (次の文字) */
  end: number;
  /** 原文表示に使う元の文字列 */
  raw: string;
};

/** `<` からタグ 1 つを読む。タグとして読めなければ null (本文の `<` はそのまま文字として扱う) */
function readTag(text: string, start: number): RawTag | null {
  if (text[start] !== "<") return null;
  const gt = text.indexOf(">", start + 1);
  if (gt === -1 || gt - start > MAX_TAG_LENGTH) return null;
  const raw = text.slice(start, gt + 1);
  const inner = raw.slice(1, -1);
  const closing = inner.startsWith("/");
  const body = closing ? inner.slice(1) : inner;
  const name = /^([A-Za-z][A-Za-z0-9-]*)/.exec(body);
  if (name === null) return null;
  // `/` を自己終了と見なすのはタグ名の直後か区切りの直後のときだけ (`<img src=/x/>` の `/` は属性値の一部)
  const selfClosing = !closing && isSelfClosingSlash(body, name[1].length);
  const content = selfClosing ? body.replace(/\/\s*$/, "") : body;
  const tag = name[1].toLowerCase();
  if (closing && content.slice(name[1].length).trim() !== "") return null;
  const attrs: HtmlAttrs = {};
  if (!closing) {
    const attr = /\s*([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/y;
    // 末尾の空白 (`<br />` の `/` の前後など) は属性の区切りとして落とす
    const tail = content.slice(name[1].length).trimEnd();
    let at = 0;
    while (at < tail.length) {
      attr.lastIndex = at;
      const match = attr.exec(tail);
      // 読めない属性が残っていればタグとして扱わない
      if (match === null || match[0].length === 0) return null;
      at += match[0].length;
      const value = match[3] ?? match[4] ?? match[5] ?? "";
      const key = match[1].toLowerCase();
      if (key === "href") attrs.href = value;
      else if (key === "title") attrs.title = value;
      else if (key === "src") attrs.src = value;
      else if (key === "alt") attrs.alt = value;
    }
  }
  return { closing, tag, attrs, selfClosing, end: gt + 1, raw };
}

/** 末尾の `/` が自己終了の印か。HTML のトークナイザに合わせ、区切りの無い属性値の途中の `/` は値に残す */
function isSelfClosingSlash(body: string, nameLength: number): boolean {
  const slash = /\/\s*$/.exec(body);
  if (slash === null) return false;
  if (slash.index === nameLength) return true;
  const previous = body[slash.index - 1];
  return previous === '"' || previous === "'" || /\s/.test(previous);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** 生 HTML のテキスト部分だけ実体参照を戻す (標準 5 種と数値参照のみ。markdown 本文はそのまま表示する) */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    let code: number;
    if (body.startsWith("#x") || body.startsWith("#X")) code = Number.parseInt(body.slice(2), 16);
    else if (body.startsWith("#")) code = Number.parseInt(body.slice(1), 10);
    else return NAMED_ENTITIES[body] ?? match;
    // サロゲート域や範囲外の符号位置は文字にできないので原文のまま残す
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
    return String.fromCodePoint(code);
  });
}

/** 許可タグの属性を絞る。危険な URL は null を返し、呼び出し側がタグごと原文表示へ落とす */
function filterAttrs(tag: string, raw: HtmlAttrs): HtmlAttrs | null {
  if (tag === "a") {
    const attrs: HtmlAttrs = {};
    if (raw.href !== undefined) {
      const href = safeUrl(raw.href, "link");
      if (href === null) return null;
      attrs.href = href;
    }
    if (raw.title) attrs.title = raw.title;
    return attrs;
  }
  if (tag === "img") {
    const src = raw.src === undefined ? null : safeUrl(raw.src, "image");
    if (src === null) return null;
    return { src, alt: raw.alt ?? "", ...(raw.title ? { title: raw.title } : {}) };
  }
  // それ以外のタグは装飾・識別属性をすべて落とす (色や大きさはテーマ側の CSS が決める)
  return {};
}

/**
 * `start` の `<` から 1 つの HTML 断片を読む。
 * タグとして読めない場合は null を返す (呼び出し側は本文の文字として扱う)。
 */
export function parseHtml(
  text: string,
  start: number,
  depth = 0,
  budget: HtmlBudget | null = null,
): { node: HtmlNode; end: number } | null {
  const tag = readTag(text, start);
  if (tag === null) return null;
  if (tag.closing || depth >= MAX_HTML_DEPTH || !ALLOWED_TAGS.has(tag.tag) || isExhausted(budget)) {
    return { node: { kind: "verbatim", text: tag.raw }, end: tag.end };
  }
  const attrs = filterAttrs(tag.tag, tag.attrs);
  if (attrs === null) return { node: { kind: "verbatim", text: tag.raw }, end: tag.end };
  if (VOID_TAGS.has(tag.tag) || tag.selfClosing) {
    return { node: { kind: "element", tag: tag.tag as HtmlTag, attrs, children: [] }, end: tag.end };
  }

  const children: HtmlNode[] = [];
  let at = tag.end;
  while (at < text.length) {
    if (spend(budget, 1)) {
      return { node: { kind: "verbatim", text: tag.raw }, end: tag.end };
    }
    if (text[at] !== "<") {
      const next = text.indexOf("<", at);
      const end = next === -1 ? text.length : next;
      spend(budget, end - at);
      children.push({ kind: "text", text: decodeEntities(text.slice(at, end)) });
      at = end;
      continue;
    }
    const closing = readTag(text, at);
    if (closing !== null && closing.closing && closing.tag === tag.tag) {
      return { node: { kind: "element", tag: tag.tag as HtmlTag, attrs, children }, end: closing.end };
    }
    const child = parseHtml(text, at, depth + 1, budget);
    if (child === null) {
      children.push({ kind: "text", text: "<" });
      at += 1;
      continue;
    }
    children.push(child.node);
    at = child.end;
  }
  // 対応する閉じタグが無いときは開始タグだけ原文にする (自動補完は持ち込まない)
  return { node: { kind: "verbatim", text: tag.raw }, end: tag.end };
}

function isExhausted(budget: HtmlBudget | null): boolean {
  return budget !== null && budget.steps <= 0;
}

/** 上限を超えたら true を返す (呼び出し側はその場で原文表示へ落とす) */
function spend(budget: HtmlBudget | null, steps: number): boolean {
  if (budget === null) return false;
  budget.steps -= steps;
  return budget.steps <= 0;
}
