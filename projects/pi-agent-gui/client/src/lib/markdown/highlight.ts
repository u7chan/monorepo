/**
 * 言語別のシンタックスハイライト。外部ライブラリを足さないため、言語ごとの順序つきルールで
 * トークン列に分解するだけにして、HTML 文字列は一切組み立てない。
 */

/** これを超えるコードはハイライトせず素のブロックにする */
export const HIGHLIGHT_MAX_LENGTH = 40 * 1024;

export type MdTokenKind = "key" | "str" | "num" | "com" | "fn" | "type" | "op" | "plain";

export type MdToken = { kind: MdTokenKind; text: string };

type Rule = { kind: MdTokenKind; re: RegExp };

/** classify に渡す文脈。行頭判定 (コマンド名) と直後の `(` 判定 (関数呼び出し) に使う */
type WordContext = { linePrefix: string; rest: string };

type LangSpec = {
  rules: Rule[];
  /** 識別子 1 語の種別。null は素のテキスト */
  classify?: (word: string, context: WordContext) => MdTokenKind | null;
};

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;

const TS_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "while",
  "yield",
]);

const TS_TYPES = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "unknown",
  "void",
]);

const C_LIKE_RULES: Rule[] = [
  { kind: "com", re: /\/\/[^\n]*/y },
  { kind: "com", re: /\/\*[\s\S]{0,4000}?\*\//y },
  { kind: "str", re: /`(?:\\[\s\S]|[^\\`]){0,4000}`/y },
  { kind: "str", re: /"(?:\\[\s\S]|[^\\"\n]){0,4000}"/y },
  { kind: "str", re: /'(?:\\[\s\S]|[^\\'\n]){0,4000}'/y },
  { kind: "num", re: /0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?/y },
  { kind: "op", re: /[+\-*/%=<>!&|^~?]+/y },
  { kind: "op", re: /[{}[\]();,.:]+/y },
];

const TS_SPEC: LangSpec = {
  rules: C_LIKE_RULES,
  classify: (word, context) => {
    if (TS_KEYWORDS.has(word)) return "key";
    if (TS_TYPES.has(word)) return "type";
    if (/^\s*\(/.test(context.rest)) return "fn";
    return /^[A-Z]/.test(word) ? "type" : null;
  },
};

const JSON_SPEC: LangSpec = {
  rules: [
    { kind: "key", re: /"(?:\\[\s\S]|[^\\"]){0,4000}"(?=\s*:)/y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"]){0,4000}"/y },
    { kind: "num", re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
    { kind: "op", re: /[{}[\],:]/y },
  ],
  classify: (word) => (word === "true" || word === "false" || word === "null" ? "key" : null),
};

const PY_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "self",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

const PYTHON_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /#[^\n]*/y },
    { kind: "str", re: /"""[\s\S]{0,4000}?"""|'''[\s\S]{0,4000}?'''/y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"\n]){0,4000}"|'(?:\\[\s\S]|[^\\'\n]){0,4000}'/y },
    { kind: "fn", re: /@[A-Za-z_][\w.]*/y },
    { kind: "num", re: /\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/y },
    { kind: "op", re: /[+\-*/%=<>!&|^~]+/y },
    { kind: "op", re: /[{}[\]();,.:]+/y },
  ],
  classify: (word, context) => {
    if (PY_KEYWORDS.has(word)) return "key";
    if (/^\s*\(/.test(context.rest)) return "fn";
    return /^[A-Z]/.test(word) ? "type" : null;
  },
};

const BASH_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /#[^\n]*/y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"]){0,4000}"/y },
    { kind: "str", re: /'[^']*'/y },
    { kind: "type", re: /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/y },
    { kind: "num", re: /\d[\d_]*(?:\.\d+)?/y },
    { kind: "op", re: /--?[A-Za-z][A-Za-z0-9-]*/y },
    { kind: "op", re: /[|&;<>()=]+/y },
  ],
  // 行頭の語をコマンド名として扱う
  classify: (_word, context) => (context.linePrefix.trim() === "" ? "fn" : null),
};

const CSS_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /\/\*[\s\S]{0,4000}?\*\//y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"\n]){0,4000}"|'(?:\\[\s\S]|[^\\'\n]){0,4000}'/y },
    { kind: "key", re: /@[A-Za-z-]+/y },
    { kind: "num", re: /#[0-9a-fA-F]{3,8}/y },
    { kind: "num", re: /-?\d[\d.]*(?:[a-z%]+)?/y },
    { kind: "fn", re: /[A-Za-z-]+(?=\s*:)/y },
    { kind: "type", re: /[.#][A-Za-z_][\w-]*|::?[A-Za-z-]+/y },
    { kind: "op", re: /[{}();:,>+~*]+/y },
    { kind: "type", re: /[A-Za-z-]+/y },
  ],
};

const HTML_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /<!--[\s\S]{0,4000}?-->/y },
    { kind: "com", re: /<!\[CDATA\[[\s\S]{0,4000}?\]\]>|<![A-Za-z][^>]*>/y },
    { kind: "key", re: /<\/?[A-Za-z][A-Za-z0-9-]*/y },
    { kind: "op", re: /\/?>/y },
    { kind: "type", re: /[A-Za-z_:][A-Za-z0-9_:.-]*(?=\s*=)/y },
    { kind: "str", re: /"[^"]*"|'[^']*'/y },
    { kind: "op", re: /=/y },
  ],
};

const MD_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /```[^\n]*/y },
    { kind: "str", re: /`[^`\n]*`/y },
    { kind: "key", re: /#{1,6}(?=\s)/y },
    { kind: "type", re: /\[[^\]\n]*\]\([^)\n]*\)/y },
    { kind: "op", re: /\*\*|__|~~|\*|_|\d+\. /y },
  ],
};

const SPECS: Record<string, LangSpec> = {
  ts: TS_SPEC,
  json: JSON_SPEC,
  python: PYTHON_SPEC,
  bash: BASH_SPEC,
  css: CSS_SPEC,
  html: HTML_SPEC,
  md: MD_SPEC,
};

const ALIASES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  mjs: "ts",
  cjs: "ts",
  json: "json",
  jsonc: "json",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  python: "python",
  css: "css",
  html: "html",
  xml: "html",
  diff: "diff",
  patch: "diff",
  md: "md",
  markdown: "md",
};

/** フェンスの info 文字列を正規化する。未知の言語・超大入力では null (ハイライトしない) */
export function highlightCode(text: string, lang: string | null): MdToken[] | null {
  if (text.length > HIGHLIGHT_MAX_LENGTH) return null;
  const name = normalizeLang(lang);
  if (name === null) return null;
  if (name === "diff") return highlightDiff(text);
  return tokenize(text, SPECS[name]);
}

/** ```` ```{ts} ```` や `TS` も受ける */
function normalizeLang(lang: string | null): string | null {
  if (lang === null) return null;
  const name = lang
    .trim()
    .toLowerCase()
    .replace(/^\{|\}$/g, "")
    .replace(/^\./, "");
  return ALIASES[name] ?? null;
}

function tokenize(text: string, spec: LangSpec): MdToken[] {
  const tokens: MdToken[] = [];
  const push = (kind: MdTokenKind, value: string) => {
    if (value === "") return;
    const last = tokens[tokens.length - 1];
    // 連続する素のテキストは 1 トークンにまとめて DOM を増やさない
    if (last !== undefined && last.kind === kind) last.text += value;
    else tokens.push({ kind, text: value });
  };

  let at = 0;
  while (at < text.length) {
    let matched = false;
    for (const rule of spec.rules) {
      rule.re.lastIndex = at;
      const match = rule.re.exec(text);
      if (match !== null && match[0].length > 0) {
        push(rule.kind, match[0]);
        at += match[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    WORD.lastIndex = at;
    const word = WORD.exec(text);
    if (word !== null) {
      const lineStart = text.lastIndexOf("\n", at - 1) + 1;
      const kind = spec.classify?.(word[0], {
        linePrefix: text.slice(lineStart, at),
        rest: text.slice(at + word[0].length),
      });
      push(kind ?? "plain", word[0]);
      at += word[0].length;
      continue;
    }
    push("plain", text[at]);
    at += 1;
  }
  return tokens;
}

function highlightDiff(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) tokens.push({ kind: "plain", text: "\n" });
    if (line === "") return;
    if (line.startsWith("@@")) tokens.push({ kind: "key", text: line });
    else if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(line)) {
      tokens.push({ kind: "com", text: line });
    } else if (line.startsWith("+")) tokens.push({ kind: "str", text: line });
    else if (line.startsWith("-")) tokens.push({ kind: "type", text: line });
    else tokens.push({ kind: "plain", text: line });
  });
  return tokens;
}
