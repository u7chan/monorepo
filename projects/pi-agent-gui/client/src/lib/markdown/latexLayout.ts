/**
 * MathNode を「CSS クラス + 子 + 派生値」のレイアウトモデルへ写す。
 * 行数やネストから括弧の大きさを決める計算を解析側と MathView のどちらにも置かないための分離。
 */
import type { MathEnv, MathNode } from "./types";

/** 環境ごとの括弧。pmatrix は両側、cases は開き括弧だけを出す */
const ENV_DELIMITERS: Record<MathEnv, { open: string; close: string | null }> = {
  pmatrix: { open: "(", close: ")" },
  cases: { open: "{", close: null },
};

/** 括弧の拡大段階。実寸は測らないので、要素の段数から決める (CSS 側に対応するクラスがある) */
const MAX_DELIM_SCALE = 4;

export type MathLayout =
  | { kind: "row"; children: MathLayout[] }
  /** cls は .mat (変数・数字) と .mop (演算子・関数名) */
  | { kind: "atom"; cls: "mat" | "mop"; text: string }
  /** \quad (cls .msp) と \qquad (cls .msp-wide)。本文の空白は atom にする */
  | { kind: "space"; cls: "msp" | "msp-wide" }
  | { kind: "frac"; num: MathLayout; den: MathLayout }
  | { kind: "sqrt"; index: MathLayout | null; body: MathLayout }
  /** word は lim のように語を組む大型演算子 */
  | { kind: "bigop"; glyph: string; word: boolean; upper: MathLayout | null; lower: MathLayout | null }
  | { kind: "script"; base: MathLayout; sup: MathLayout | null; sub: MathLayout | null }
  | { kind: "fenced"; open: MathLayout | null; close: MathLayout | null; body: MathLayout }
  | { kind: "delim"; text: string; scale: number }
  /** cls は .mtx (行列) と .cases。cells は行優先で、足りないセルは empty で埋める */
  | {
      kind: "matrix";
      cls: "mtx" | "cases";
      columns: number;
      cells: MathLayout[];
      open: MathLayout | null;
      close: MathLayout | null;
    }
  | { kind: "empty" };

export function toMathLayout(node: MathNode): MathLayout {
  switch (node.kind) {
    case "row":
      return { kind: "row", children: node.children.map(toMathLayout) };
    case "text":
      return { kind: "atom", cls: "mat", text: node.text };
    case "op":
      return { kind: "atom", cls: "mop", text: node.text };
    case "space":
      // \quad 系だけ空きを要素にし、本文の空白は文字のまま流す
      if (node.width === 1) return { kind: "space", cls: "msp" };
      if (node.width === 2) return { kind: "space", cls: "msp-wide" };
      return { kind: "atom", cls: "mat", text: " " };
    case "frac":
      return { kind: "frac", num: toMathLayout(node.num), den: toMathLayout(node.den) };
    case "sqrt":
      return {
        kind: "sqrt",
        index: node.index === null ? null : toMathLayout(node.index),
        body: toMathLayout(node.body),
      };
    case "bigop":
      return {
        kind: "bigop",
        glyph: node.glyph,
        word: /^[A-Za-z]+$/.test(node.glyph),
        upper: node.upper === null ? null : toMathLayout(node.upper),
        lower: node.lower === null ? null : toMathLayout(node.lower),
      };
    case "script":
      return {
        kind: "script",
        base: toMathLayout(node.base),
        sup: node.sup === null ? null : toMathLayout(node.sup),
        sub: node.sub === null ? null : toMathLayout(node.sub),
      };
    case "fenced": {
      const body = toMathLayout(node.body);
      const scale = scaleFor(node.body);
      return { kind: "fenced", open: delim(node.open, scale), close: delim(node.close, scale), body };
    }
    case "grid":
      return gridLayout(node.env, node.rows);
  }
}

function gridLayout(env: MathEnv, rows: MathNode[][]): MathLayout {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const cells: MathLayout[] = [];
  for (const row of rows) {
    for (let at = 0; at < columns; at += 1) {
      const cell = row[at];
      // 行ごとにセルが足りない場合は空のセルで埋める (grid の列がずれない)
      cells.push(cell === undefined ? { kind: "empty" } : toMathLayout(cell));
    }
  }
  const delimiters = ENV_DELIMITERS[env];
  // 行数から括弧の段階を決める (実寸は測らない)
  const scale = Math.min(MAX_DELIM_SCALE, Math.max(1, rows.length));
  return {
    kind: "matrix",
    cls: env === "pmatrix" ? "mtx" : "cases",
    columns,
    cells,
    open: delim(delimiters.open, scale),
    close: delimiters.close === null ? null : delim(delimiters.close, scale),
  };
}

function delim(text: string, scale: number): MathLayout | null {
  if (text === "") return null;
  return { kind: "delim", text, scale };
}

/** 括弧の段階。分数・大型演算子・行列が入るほど大きくし、上限で止める */
function scaleFor(node: MathNode): number {
  const scaled = Math.ceil(heightOf(node) / 3);
  return Math.min(MAX_DELIM_SCALE, Math.max(1, scaled));
}

/** 行数を高さの目安にする (高さ 3 = 1 段階)。TeX の組版を再現せず、決定的な値だけを返す */
function heightOf(node: MathNode): number {
  switch (node.kind) {
    case "row":
      return node.children.reduce((max, child) => Math.max(max, heightOf(child)), 2);
    case "frac":
      return heightOf(node.num) + heightOf(node.den) + 2;
    case "sqrt":
      return heightOf(node.body) + 1;
    case "bigop":
      return (
        Math.max(2, node.upper === null ? 0 : heightOf(node.upper), node.lower === null ? 0 : heightOf(node.lower)) + 4
      );
    case "script":
      return heightOf(node.base) + 1;
    case "fenced":
      return heightOf(node.body);
    case "grid":
      return node.rows.length * 3;
    default:
      return 2;
  }
}
