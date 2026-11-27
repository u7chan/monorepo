/**
 * 2 行を超えるコメントを ratchet で止める。規則は AGENTS.md「コメント」節。
 * 中身が What / How / Why かは review で見る。ここでは機械的に数えられる行数だけを見る。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 対象。フロントエンドの実測値から始め、server は掃除が済んだ時点で足す。 */
const scanTargets = ["client/src"];

/** 現在の実測値の ratchet。減らすのは自由で、増やすときは diff に出してレビューで合意する。 */
const LONG_COMMENT_BUDGET = 18;

/** prose として数えない行。参照ディレクティブと lint / format の制御は長さの対象外。 */
const directivePattern = /^\/\/\s*(?:oxlint|eslint|@ts-|prettier-|#region|#endregion)/;

/** `/` の直前がこれなら式の始まりで正規表現。値や `)` `]` `}` の後ろは除算。 */
const regexpAfterChar = /[(,=:[!&|?;{+\-*%^~<>]/;

/** 同じく式が始まる予約語。識別子の終わりに判定する。 */
const regexpAfterWord = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "instanceof",
  "yield",
  "await",
  "do",
  "else",
  "throw",
]);

/** 式が始まる位置か。`previous` は直前の意味のある字か `"value"` / `"word"`。 */
function startsRegexp(previous) {
  if (previous === null) return true;
  if (previous === "word") return true;
  if (previous === "value") return false;
  return regexpAfterChar.test(previous);
}

/** 正規表現リテラルを読む。1 行で閉じなければ除算として扱い、開始位置を返す。 */
function skipRegexp(text, start) {
  let inClass = false;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") return start + 1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i += 1;
      while (i < text.length && /[a-z]/.test(text[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return start + 1;
}

function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && text[i + 1] === "{") {
      i = skipExpression(text, i + 2);
      continue;
    }
    if (ch === "\n" && quote !== "`") return i;
    i += 1;
  }
  return i;
}

/** テンプレートの `${}` の中。閉じ括弧の次を返す。 */
function skipExpression(text, start) {
  let depth = 1;
  let previous = null;
  let word = "";
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (word !== "" && !/[A-Za-z0-9_$]/.test(ch)) {
      previous = regexpAfterWord.has(word) ? "word" : "value";
      word = "";
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      previous = "value";
      word = "";
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (ch === "/" && startsRegexp(previous)) {
      i = skipRegexp(text, i);
      previous = "value";
      word = "";
      continue;
    }
    if (ch === "{") {
      depth += 1;
      previous = "{";
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      previous = "value";
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      word += ch;
      i += 1;
      continue;
    }
    if ((ch === "+" || ch === "-") && previous === ch) previous = "value";
    else previous = ch;
    i += 1;
  }
  return i;
}

/** 行の外側のコメント記号を落とし、中身が空の行は数えない。 */
function proseLinesOf(raw) {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\{?\/\*+!?\s?/, "")
        .replace(/\*+\/\}?\s*$/, "")
        .replace(/^\s*\/\/+\s?/, "")
        .replace(/^\s*\*+\s?/, "")
        .trimEnd(),
    )
    .filter((line) => line.trim() !== "");
}

/** 直前に `\` がある `//` は正規表現のエスケープ。行中の `//` は直前が空白のときだけコメント。 */
function startsLineComment(text, index) {
  if (text[index - 1] === "\\") return false;
  return index === 0 || /\s/.test(text[index - 1]);
}

/** 式の途中でもコメントを拾う。JSX の `{/* ... *\/}` は `{` の後ろに来る。 */
function startsBlockComment(text, index) {
  if (text[index - 1] === "\\") return false;
  if (index === 0) return true;
  return /[\s({,;=:]/.test(text[index - 1]);
}

function commentsOf(text) {
  const raw = [];
  let i = 0;
  let line = 1;
  let cursor = 0;
  let previous = null;
  let word = "";
  const lineAt = (position) => {
    for (; cursor < position; cursor += 1) {
      if (text[cursor] === "\n") line += 1;
    }
    return line;
  };

  while (i < text.length) {
    const ch = text[i];
    if (word !== "" && !/[A-Za-z0-9_$]/.test(ch)) {
      previous = regexpAfterWord.has(word) ? "word" : "value";
      word = "";
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      previous = "value";
      word = "";
      continue;
    }
    if (ch === "/" && text[i + 1] === "/" && startsLineComment(text, i)) {
      const newline = text.indexOf("\n", i);
      const end = newline === -1 ? text.length : newline;
      raw.push({ line: lineAt(i), kind: "line", body: text.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*" && startsBlockComment(text, i)) {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      raw.push({ line: lineAt(i), kind: "block", body: text.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === "/" && startsRegexp(previous)) {
      const end = skipRegexp(text, i);
      if (end > i + 1) {
        i = end;
        previous = "value";
        word = "";
        continue;
      }
    }
    if (/\s/.test(ch)) {
      if (word !== "") previous = regexpAfterWord.has(word) ? "word" : "value";
      word = "";
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      word += ch;
      i += 1;
      continue;
    }
    if ((ch === "+" || ch === "-") && previous === ch) previous = "value";
    else previous = ch;
    i += 1;
  }

  const merged = [];
  for (const comment of raw) {
    if (comment.kind === "line" && (comment.body.startsWith("///") || directivePattern.test(comment.body))) {
      continue;
    }
    const endLine = comment.line + comment.body.split("\n").length - 1;
    const prev = merged.at(-1);
    if (prev && prev.kind === "line" && comment.kind === "line" && comment.line === prev.endLine + 1) {
      prev.body += `\n${comment.body}`;
      prev.endLine = endLine;
      continue;
    }
    merged.push({ ...comment, endLine });
  }

  return merged.map((comment) => {
    const lines = proseLinesOf(comment.body);
    const text = lines.join(" ");
    return {
      line: comment.line,
      endLine: comment.endLine,
      lines: lines.length,
      chars: text.replace(/\s/g, "").length,
      text,
    };
  });
}

/**
 * JSX の子要素に置いた `/**` はコメントではなく文字として描画される (実際に踏んだ不具合)。
 * 直前の行が `>` `}` `)` で終わり、次の行が子要素 (`<` / `{` / `(`) で始まる `/**` を行番号で返す。
 * 属性の間 (`onClose={` など) と `=>` の後ろはコメントなので除く。
 */
function jsxTextComments(text) {
  const lines = text.split("\n");
  const found = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.length - line.trimStart().length;
    if (indent < 4 || !line.trimStart().startsWith("/**")) continue;
    let previous = index - 1;
    while (previous >= 0 && lines[previous].trim() === "") previous -= 1;
    let end = index;
    while (end < lines.length && !lines[end].includes("*/")) end += 1;
    let next = end + 1;
    while (next < lines.length && lines[next].trim() === "") next += 1;
    if (previous < 0 || next >= lines.length) continue;
    const before = lines[previous].trimEnd();
    const after = lines[next].trimStart();
    const children = before.endsWith(">") || before.endsWith("}") || before.endsWith(")");
    const attribute = /^[A-Za-z_$][\w$]*\s*=/.test(after) || after.startsWith("...");
    const child = after.startsWith("<") || after.startsWith("{") || after.startsWith("(");
    if (children && !before.endsWith("=>") && !attribute && child) found.push(index + 1);
  }
  return found;
}

/** しきい値は 3 行。1〜2 行に収まっていれば長さでは判定しない。 */
const isOverLong = (comment) => comment.lines >= 3;

function collect(target) {
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const child = join(target, entry.name);
    if (entry.isDirectory()) return collect(child);
    return /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

function main() {
  const list = process.argv.includes("--list");
  const found = [];
  const errors = [];
  for (const target of scanTargets) {
    for (const file of collect(join(root, target))) {
      const shown = relative(root, file);
      const text = readFileSync(file, "utf8");
      if (file.endsWith(".tsx")) {
        for (const line of jsxTextComments(text)) {
          errors.push(`${shown}:${line}: JSX の子の /** は文字として描画される。{/* */} にする`);
        }
      }
      for (const comment of commentsOf(text)) {
        if (isOverLong(comment)) found.push({ file: shown, ...comment });
      }
    }
  }
  found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const lines = found.reduce((sum, comment) => sum + comment.lines, 0);
  const summary = `2 行超のコメント ${found.length} 件 / ${lines} 行、予算 ${LONG_COMMENT_BUDGET} 件`;
  const tighten = `予算を ${found.length} に下げられる (現在 ${LONG_COMMENT_BUDGET})`;

  if (errors.length > 0) {
    console.error(errors.join("\n"));
  }

  if (list) {
    for (const comment of found) {
      const preview = comment.text.length > 70 ? `${comment.text.slice(0, 70)}…` : comment.text;
      console.log(
        `${comment.file}:${comment.line}-${comment.endLine} (${comment.lines} 行, ${comment.chars} 字) ${preview}`,
      );
    }
    console.error(`comment check: ${summary}`);
    if (found.length > LONG_COMMENT_BUDGET || errors.length > 0) process.exit(1);
    return;
  }

  if (found.length > LONG_COMMENT_BUDGET || errors.length > 0) {
    console.error(`comment check: ${summary}`);
    console.error("足したコメントを 1〜2 行に縮めるか docs/ へ理由を移す。全件は --list、予算を上げるなら diff に出す");
    process.exit(1);
  }
  console.log(`comment check: ok (${summary})`);
  if (found.length < LONG_COMMENT_BUDGET) console.error(`comment check: ${tighten}`);
}

export { commentsOf, isOverLong, jsxTextComments };

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
