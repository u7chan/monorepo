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
  /** text は数式の中身、source は区切り込みの原文 (解析に失敗したときは source を出す) */
  | { kind: "math"; text: string; source: string }
  | { kind: "hr" };

/** 数式の環境。どちらも `&` で列、`\\` で行を区切る */
export type MathEnv = "pmatrix" | "cases";

/**
 * 数式 (LaTeX サブセット) の解析結果。DOM / React に依存しない値だけで表し、
 * 見た目は latexLayout.ts が CSS クラスのモデルへ写す。
 */
export type MathNode =
  | { kind: "row"; children: MathNode[] }
  /** 変数・数字・ギリシャ文字など */
  | { kind: "text"; text: string }
  /** 演算子と関数名。前後の空きは CSS 側が持つ */
  | { kind: "op"; text: string }
  /** width は \quad (1) / \qquad (2)。0 は本文中の空白 1 つ */
  | { kind: "space"; width: 0 | 1 | 2 }
  | { kind: "frac"; num: MathNode; den: MathNode }
  /** index は \sqrt[n] の n。無いときは null */
  | { kind: "sqrt"; index: MathNode | null; body: MathNode }
  /** 上下限つきの大型演算子 (\sum \int \prod \lim)。下限は lower に置く */
  | { kind: "bigop"; glyph: string; lower: MathNode | null; upper: MathNode | null }
  | { kind: "script"; base: MathNode; sub: MathNode | null; sup: MathNode | null }
  /** \left…\right。delimiter 無し (`.`) の側は空文字になる */
  | { kind: "fenced"; open: string; close: string; body: MathNode }
  /** rows は行 → セル。セルは row ノードで、列数は行ごとに違ってよい */
  | { kind: "grid"; env: MathEnv; rows: MathNode[][] };

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
  | { kind: "html"; node: HtmlNode }
  /** インライン数式。解析に失敗した `$…$` は literal (原文) になるので、ここには来ない */
  | { kind: "math"; node: MathNode };
