/** Markdown サブセットの解析結果。DOM / React に依存しない値だけを持ち、Node のテストで固定する。 */

export type MdAlign = "left" | "center" | "right";

export type MdHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MdListItem = {
  /** タスクリストのチェック状態 (`- [x]` / `- [ ]`)。通常の項目は null */
  task: boolean | null;
  /** 項目の本文 (入れ子のリスト行を含む)。描画側が再帰的に解析する */
  source: string;
};

export type MdBlock =
  /** source はインライン記法を含む本文ソース */
  | { kind: "heading"; level: MdHeadingLevel; source: string }
  | { kind: "paragraph"; source: string }
  /** closed が false のときは未終端のフェンス (ストリーミング中として表示する) */
  | { kind: "code"; lang: string | null; text: string; closed: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: "quote"; source: string }
  | { kind: "table"; align: MdAlign[]; header: string[]; rows: string[][] }
  | { kind: "hr" };

/** 生 HTML の許可タグ。これ以外のタグはタグごと原文表示にする */
export type HtmlTag =
  | "b"
  | "strong"
  | "i"
  | "em"
  | "u"
  | "s"
  | "del"
  | "ins"
  | "code"
  | "kbd"
  | "mark"
  | "small"
  | "sub"
  | "sup"
  | "span"
  | "a"
  | "br"
  | "hr"
  | "img";

/** 内容に意味を持つ属性だけを残す。装飾・識別属性 (style / class / id / on*) は持ってこない */
export type HtmlAttrs = { href?: string; title?: string; src?: string; alt?: string };

export type HtmlNode =
  | { kind: "text"; text: string }
  /** 許可外のタグ・不正な URL・対応しない閉じタグ。実行も描画もせず原文を等幅で見せる */
  | { kind: "verbatim"; text: string }
  | { kind: "element"; tag: HtmlTag; attrs: HtmlAttrs; children: HtmlNode[] };

export type MdInline =
  | { kind: "text"; text: string }
  /** 解析できなかった記法 (不正な URL のリンクなど)。原文を等幅で見せる */
  | { kind: "literal"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "del"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; title: string | null; children: MdInline[] }
  /** src は同一オリジン (= 相対パス) だけ。それ以外は literal に落ちる */
  | { kind: "image"; src: string; alt: string }
  | { kind: "break" }
  | { kind: "html"; node: HtmlNode };
