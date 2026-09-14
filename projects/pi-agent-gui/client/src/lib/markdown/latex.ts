/**
 * LaTeX サブセットのトークナイザと解析。DOM / React に依存しない純関数で、
 * 解釈できない入力は例外を投げずに ok: false を返す (呼び出し側が原文表示に落とす)。
 */
import type { MathEnv, MathNode } from "./types";

/** 数式 1 つの文字数上限。伸びる本文でも 1 フレームの作業量を固定する */
export const LATEX_MAX_LENGTH = 20000;

/** 生成するノード数の上限 (短くても区切りを大量に並べた入力があるため) */
export const LATEX_MAX_NODES = 4000;

/** 入れ子の上限。`{` や `\left` の連続でスタックを食い潰さない */
const MAX_DEPTH = 16;

/** 行列の列数の上限。列数は CSS クラスで決めるため、広すぎる行列は原文に落とす */
const MAX_COLUMNS = 6;

export type LatexParseResult = { ok: true; node: MathNode } | { ok: false };

/** 数式 1 つを解析する。失敗は例外ではなく ok: false で返す */
export function parseLatex(source: string): LatexParseResult {
  if (source.length > LATEX_MAX_LENGTH || source.trim() === "") return { ok: false };
  const tokens = tokenize(source);
  if (tokens === null) return { ok: false };
  const node = parseTokens(tokens, 0, { nodes: LATEX_MAX_NODES });
  if (node === null) return { ok: false };
  return { ok: true, node };
}

/** 文字としてそのまま出す記号 (変数・数字・ギリシャ文字など) */
const ATOMS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  cdots: "⋯",
  ldots: "…",
};

/** 演算子 (前後に空きを入れる) */
const OPERATORS: Record<string, string> = {
  le: "≤",
  ge: "≥",
  ne: "≠",
  pm: "±",
  mp: "∓",
  times: "×",
  cdot: "·",
  div: "÷",
  to: "→",
  approx: "≈",
  equiv: "≡",
  in: "∈",
  subset: "⊂",
  cup: "∪",
  cap: "∩",
  Rightarrow: "⇒",
  Leftrightarrow: "⇔",
};

/** 立体で出す関数名 */
const FUNCTIONS = new Set(["log", "ln", "sin", "cos", "tan", "exp", "max", "min"]);

/** 上下限を縦に積む大型演算子。lim は語なので CSS 側で大きさを変える */
const BIGOPS: Record<string, string> = { sum: "∑", int: "∫", prod: "∏", lim: "lim" };

/** 数式の中で素の記号として扱う文字。`{}` `^` `_` `&` `\` などは制御用に予約する */
const OP_CHARS = "=+-<>±∓×÷·⋅≤≥≠≈≡→←↔⇒⇔⊂⊃⊆⊇∈∉∪∩∀∃∂∇∧∨";
const PUNCT_CHARS = "()[],;:.|";
const RESERVED = "\\{}^_&$~%#";

type Token =
  | { t: "text"; v: string }
  | { t: "op"; v: string }
  | { t: "punct"; v: string }
  /** 立体で出す関数名 */
  | { t: "fn"; v: string }
  /** 上下限つきの大型演算子 */
  | { t: "big"; v: string }
  | { t: "space"; w: 0 | 1 | 2 }
  /** \text{…} の中身。中は数式として解釈しない */
  | { t: "txt"; v: string }
  | { t: "open" }
  | { t: "close" }
  | { t: "sup" }
  | { t: "sub" }
  | { t: "amp" }
  | { t: "rowbreak" }
  | { t: "frac" }
  | { t: "sqrt" }
  | { t: "left" }
  | { t: "right" }
  | { t: "begin"; env: MathEnv }
  | { t: "end"; env: MathEnv };

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

/** 制御綴り 1 つをトークンにする。サブセット外の命令は null (解析全体を失敗させる) */
function commandToken(name: string): Token | null {
  const atom = ATOMS[name];
  if (atom !== undefined) return { t: "text", v: atom };
  const operator = OPERATORS[name];
  if (operator !== undefined) return { t: "op", v: operator };
  if (FUNCTIONS.has(name)) return { t: "fn", v: name };
  const big = BIGOPS[name];
  if (big !== undefined) return { t: "big", v: big };
  switch (name) {
    case "frac":
      return { t: "frac" };
    case "sqrt":
      return { t: "sqrt" };
    case "left":
      return { t: "left" };
    case "right":
      return { t: "right" };
    case "quad":
      return { t: "space", w: 1 };
    case "qquad":
      return { t: "space", w: 2 };
    default:
      return null;
  }
}

/** `\{` `\}` `\\` `\ ` だけを記号の制御綴りとして受ける */
function escapeToken(char: string): Token | null {
  switch (char) {
    case "{":
      return { t: "punct", v: "{" };
    case "}":
      return { t: "punct", v: "}" };
    case "\\":
      return { t: "rowbreak" };
    case " ":
      return { t: "space", w: 0 };
    default:
      return null;
  }
}

/** `\begin{...}` の `{...}` を読み、対応する環境名だけを受ける */
function readEnv(source: string, from: number): { env: MathEnv; end: number } | null {
  if (source[from] !== "{") return null;
  const close = source.indexOf("}", from + 1);
  if (close === -1) return null;
  const name = source.slice(from + 1, close);
  if (name !== "pmatrix" && name !== "cases") return null;
  return { env: name, end: close + 1 };
}

/** `\text{...}` の中身を波括弧の対応を数えて取り出す (中は数式として扱わない) */
function readTextArg(source: string, from: number): { text: string; end: number } | null {
  if (source[from] !== "{") return null;
  let at = from + 1;
  let depth = 1;
  let text = "";
  while (at < source.length) {
    const char = source[at];
    if (char === "\\" && (source[at + 1] === "{" || source[at + 1] === "}")) {
      text += source[at + 1];
      at += 2;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { text, end: at + 1 };
    }
    text += char;
    at += 1;
  }
  return null;
}

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === "\\") {
      const next = source[at + 1];
      // 末尾の `\` はエスケープする相手が無い
      if (next === undefined) return null;
      if (isAsciiLetter(next)) {
        let end = at + 1;
        while (end < source.length && isAsciiLetter(source[end])) end += 1;
        const name = source.slice(at + 1, end);
        if (name === "begin" || name === "end") {
          const env = readEnv(source, end);
          if (env === null) return null;
          tokens.push({ t: name, env: env.env });
          at = env.end;
          continue;
        }
        if (name === "text") {
          const arg = readTextArg(source, end);
          if (arg === null) return null;
          tokens.push({ t: "txt", v: arg.text });
          at = arg.end;
          continue;
        }
        const token = commandToken(name);
        if (token === null) return null;
        tokens.push(token);
        at = end;
        continue;
      }
      const escaped = escapeToken(next);
      if (escaped === null) return null;
      tokens.push(escaped);
      at += 2;
      continue;
    }
    if (char === "{") {
      tokens.push({ t: "open" });
      at += 1;
      continue;
    }
    if (char === "}") {
      tokens.push({ t: "close" });
      at += 1;
      continue;
    }
    if (char === "^") {
      tokens.push({ t: "sup" });
      at += 1;
      continue;
    }
    if (char === "_") {
      tokens.push({ t: "sub" });
      at += 1;
      continue;
    }
    if (char === "&") {
      tokens.push({ t: "amp" });
      at += 1;
      continue;
    }
    // `$` は区切りの外にあるべき記号なので、本文中に出たら解析しない
    if (RESERVED.includes(char)) return null;
    if (char.trim() === "") {
      while (at < source.length && source[at].trim() === "") at += 1;
      tokens.push({ t: "space", w: 0 });
      continue;
    }
    if (OP_CHARS.includes(char)) {
      // ASCII のハイフンは minus 記号にして組む
      tokens.push({ t: "op", v: char === "-" ? "−" : char });
      at += 1;
      continue;
    }
    if (PUNCT_CHARS.includes(char)) {
      tokens.push({ t: "punct", v: char });
      at += 1;
      continue;
    }
    const start = at;
    while (at < source.length && isAtomChar(source[at])) at += 1;
    // 予約文字でも演算子でもない文字は必ず 1 つ以上進む (無限ループの保険)
    if (at === start) return null;
    tokens.push({ t: "text", v: source.slice(start, at) });
  }
  return tokens;
}

function isAtomChar(char: string): boolean {
  return !RESERVED.includes(char) && !OP_CHARS.includes(char) && !PUNCT_CHARS.includes(char) && char.trim() !== "";
}

type Budget = { nodes: number };

type Parser = { tokens: Token[]; at: number };

type RowStop = "eof" | "close" | "amp" | "rowbreak" | "end";

/** 実行した作業量を数え、上限を超えたら true を返す (呼び出し側は解析を打ち切る) */
function spend(budget: Budget): boolean {
  budget.nodes -= 1;
  return budget.nodes < 0;
}

/** トークン列の全体を 1 つの row として読む (`\left` の中身もこの入口を通る) */
function parseTokens(tokens: Token[], depth: number, budget: Budget): MathNode | null {
  const row = readRow({ tokens, at: 0 }, depth, budget, "group");
  if (row === null || row.stop !== "eof") return null;
  return row.node;
}

/**
 * 行 (セル) を読む。止まった理由を返し、構文エラーは null。
 * mode は `}` で止まる group と、`&` `\\` `\end` で止まる grid の 2 つ。
 */
function readRow(
  parser: Parser,
  depth: number,
  budget: Budget,
  mode: "group" | "grid",
): { node: MathNode; stop: RowStop } | null {
  if (depth > MAX_DEPTH || spend(budget)) return null;
  const children: MathNode[] = [];
  for (;;) {
    const token = parser.tokens[parser.at];
    if (token === undefined) return { node: rowNode(children), stop: "eof" };
    switch (token.t) {
      case "close":
        if (mode !== "group") return null;
        parser.at += 1;
        return { node: rowNode(children), stop: "close" };
      case "amp":
        if (mode !== "grid") return null;
        parser.at += 1;
        return { node: rowNode(children), stop: "amp" };
      case "rowbreak":
        if (mode !== "grid") return null;
        parser.at += 1;
        return { node: rowNode(children), stop: "rowbreak" };
      case "end":
        if (mode !== "grid") return null;
        // 対応する環境かどうかは呼び出し側が確かめる
        return { node: rowNode(children), stop: "end" };
      case "right":
        // \left の外に \right だけがある入力
        return null;
      default: {
        if (spend(budget)) return null;
        const node = readScripted(parser, depth, budget);
        if (node === null) return null;
        children.push(node);
      }
    }
  }
}

/** 直前の空きだけを落とす (`\frac{ a }` の余白を組に持ち込まない) */
function rowNode(children: MathNode[]): MathNode {
  let start = 0;
  let end = children.length;
  while (start < end && children[start].kind === "space") start += 1;
  while (end > start && children[end - 1].kind === "space") end -= 1;
  return { kind: "row", children: start === 0 && end === children.length ? children : children.slice(start, end) };
}

/** 1 つの項と、それに付く上下限 (`x^2` `\sum_{i=1}^{n}`) を読む */
function readScripted(parser: Parser, depth: number, budget: Budget): MathNode | null {
  const base = readAtom(parser, depth, budget);
  if (base === null) return null;
  let sub: MathNode | null = null;
  let sup: MathNode | null = null;
  for (;;) {
    const token = parser.tokens[parser.at];
    if (token === undefined || (token.t !== "sub" && token.t !== "sup")) break;
    parser.at += 1;
    if (spend(budget)) return null;
    const arg = readScriptArg(parser, depth, budget);
    if (arg === null) return null;
    if (token.t === "sub") {
      if (sub !== null) return null;
      sub = arg;
    } else {
      if (sup !== null) return null;
      sup = arg;
    }
  }
  if (sub === null && sup === null) return base;
  // 大型演算子の上下限は横ではなく上下に積む
  if (base.kind === "bigop") return { ...base, lower: sub ?? base.lower, upper: sup ?? base.upper };
  return { kind: "script", base, sub, sup };
}

/** `^` `_` の引数。波括弧が無ければ次の 1 項だけを取る */
function readScriptArg(parser: Parser, depth: number, budget: Budget): MathNode | null {
  if (parser.tokens[parser.at]?.t === "open") return readGroup(parser, depth, budget);
  return readAtom(parser, depth, budget);
}

function readAtom(parser: Parser, depth: number, budget: Budget): MathNode | null {
  const token = parser.tokens[parser.at];
  if (token === undefined) return null;
  parser.at += 1;
  switch (token.t) {
    case "text":
    case "punct":
      return { kind: "text", text: token.v };
    case "op":
    case "fn":
      return { kind: "op", text: token.v };
    case "txt":
      return { kind: "text", text: token.v };
    case "space":
      return { kind: "space", width: token.w };
    case "big":
      return { kind: "bigop", glyph: token.v, lower: null, upper: null };
    case "frac": {
      const num = readGroup(parser, depth + 1, budget);
      const den = num === null ? null : readGroup(parser, depth + 1, budget);
      if (num === null || den === null) return null;
      return { kind: "frac", num, den };
    }
    case "sqrt": {
      let index: MathNode | null = null;
      const next = parser.tokens[parser.at];
      if (next !== undefined && next.t === "punct" && next.v === "[") {
        let close = parser.at + 1;
        while (close < parser.tokens.length) {
          const candidate = parser.tokens[close];
          if (candidate.t === "punct" && candidate.v === "]") break;
          close += 1;
        }
        if (close >= parser.tokens.length) return null;
        const inner = parseTokens(parser.tokens.slice(parser.at + 1, close), depth + 1, budget);
        if (inner === null) return null;
        index = inner;
        parser.at = close + 1;
      }
      const body = readGroup(parser, depth + 1, budget);
      if (body === null) return null;
      return { kind: "sqrt", index, body };
    }
    case "open": {
      parser.at -= 1;
      return readGroup(parser, depth + 1, budget);
    }
    case "left":
      return readFenced(parser, depth, budget);
    case "begin":
      return readGrid(parser, token.env, depth, budget);
    default:
      return null;
  }
}

/** `{...}` 1 つを row として読む */
function readGroup(parser: Parser, depth: number, budget: Budget): MathNode | null {
  if (parser.tokens[parser.at]?.t !== "open") return null;
  parser.at += 1;
  const row = readRow(parser, depth, budget, "group");
  if (row === null || row.stop !== "close") return null;
  return row.node;
}

/** `\left` `\right` が取れる括弧。`.` は「括弧を出さない」印なので空文字にする */
const DELIMITERS = new Set(["(", ")", "[", "]", "{", "}", "|", "."]);

function delimiter(token: Token | undefined): { text: string } | null {
  if (token === undefined || token.t !== "punct" || !DELIMITERS.has(token.v)) return null;
  return { text: token.v === "." ? "" : token.v };
}

/** `\left…\right`。中身は対応する `\right` までを切り出して読む (入れ子も数える) */
function readFenced(parser: Parser, depth: number, budget: Budget): MathNode | null {
  const open = delimiter(parser.tokens[parser.at]);
  if (open === null) return null;
  parser.at += 1;
  let nesting = 0;
  let closeAt = -1;
  for (let at = parser.at; at < parser.tokens.length; at += 1) {
    const token = parser.tokens[at];
    if (token.t === "left") nesting += 1;
    else if (token.t === "right") {
      if (nesting === 0) {
        closeAt = at;
        break;
      }
      nesting -= 1;
    }
  }
  if (closeAt === -1) return null;
  const close = delimiter(parser.tokens[closeAt + 1]);
  if (close === null) return null;
  const body = parseTokens(parser.tokens.slice(parser.at, closeAt), depth + 1, budget);
  if (body === null) return null;
  parser.at = closeAt + 2;
  return { kind: "fenced", open: open.text, close: close.text, body };
}

/** `\begin{pmatrix}` / `\begin{cases}`。`&` がセル、`\\` が行の区切り */
function readGrid(parser: Parser, env: MathEnv, depth: number, budget: Budget): MathNode | null {
  const rows: MathNode[][] = [];
  let cells: MathNode[] = [];
  for (;;) {
    const row = readRow(parser, depth + 1, budget, "grid");
    if (row === null) return null;
    cells.push(row.node);
    if (row.stop === "amp") continue;
    if (row.stop === "rowbreak") {
      rows.push(cells);
      cells = [];
      continue;
    }
    if (row.stop === "end") {
      const token = parser.tokens[parser.at];
      if (token === undefined || token.t !== "end" || token.env !== env) return null;
      parser.at += 1;
      rows.push(cells);
      break;
    }
    // 閉じないまま終わった入力
    return null;
  }
  // `\\` の直後に閉じた場合の空行は落とす
  while (rows.length > 1 && isBlankRow(rows[rows.length - 1])) rows.pop();
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0 || columns > MAX_COLUMNS) return null;
  return { kind: "grid", env, rows };
}

function isBlankRow(cells: MathNode[]): boolean {
  return cells.every((cell) => cell.kind === "row" && cell.children.length === 0);
}
