/**
 * docs の機械的な腐りを止める。方針は AGENTS.md「docs」節を参照。
 *
 * 検査する:
 *  - 相対リンクの参照先ファイルが存在する
 *  - リンクの #anchor が参照先の見出しに存在する
 *  - 本文中の `client/src/...` などのパスが実在する
 *  - ソースのコメントにある `docs/xxx.md#anchor` の参照先が実在する
 *  - 見出しに UI の階層 (`設定 → 通知`) を書かない (見出しがアンカーの正のため)
 *  - フロントエンドの docs が行数予算に収まっている
 *
 * 検査しない: 文が「振る舞いが変わらない変更で書き換えが要る」内容かどうか (review で判断する)。
 *
 * project root の外を指すリンク (`../../AGENTS.md` のようなモノレポ全体への参照) は、CI が
 * project 単位のビルドコンテキストでこの script を走らせるため解決できない。件数を出して未検査にする。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * フロントエンドの docs は実装の写像へ戻りやすい。実測値を起点にした ratchet で、
 * 増やすときは必ずこの数字も変える (= diff に出るので review で見える)。
 */
const DOC_LINE_BUDGET = {
  "docs/ui-layout.md": 197,
  "docs/frontend.md": 125,
};

/**
 * 検査対象。builtin-skills 配下は配布物の同梱 docs で、この規約の対象外。
 */
const scanTargets = [join(root, "AGENTS.md"), join(root, "README.md"), join(root, "docs")];

/**
 * ソースのコメントから docs を指す参照 (`docs/xxx.md#anchor`)。プロジェクト root 相対で書く。
 * ここを検査しないと、docs の見出しを変えても誰も気付かない (実際に 1 件死んでいた)。
 */
const sourceTargets = ["client/src", "client/test", "server/src", "server/test"];
const sourceDocRef = /docs\/([\w-]+\.md)#([\p{L}\p{N}\p{M}\-_]+)/gu;

/** docs が言及してよい実ファイルの置き場。 */
const pathPrefixes = ["client/", "server/", "docs/"];

/** パスとして扱わないもの (拡張子を持つが実在しない生成物や例示)。 */
const pathAllowlist = new Set(["client/dist/index.html"]);

const pathPattern = new RegExp(
  `^(?:${pathPrefixes.map((p) => p.replace("/", "\\/")).join("|")})[\\w./@-]+\\.(?:tsx?|jsx?|mjs|json|css|md|html|ya?ml)$`,
);

const errors = [];
let skippedOutOfRoot = 0;

function collectMarkdown(target) {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const child = join(target, entry.name);
    if (entry.isDirectory()) return collectMarkdown(child);
    return entry.name.endsWith(".md") ? [child] : [];
  });
}

/** GitHub の見出しアンカー。記号を落として空白を hyphen にし、日本語はそのまま残す。同名の見出しは GitHub と同じく `-1` の連番を付ける。 */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\-_ ]/gu, "")
    .replace(/ /g, "-");
}

function headingsOf(file) {
  const slugs = new Set();
  const seen = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const base = slugify(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

const headingCache = new Map();
function hasHeading(file, anchor) {
  if (!headingCache.has(file)) headingCache.set(file, headingsOf(file));
  return headingCache.get(file).has(anchor);
}

/** fenced code block と複数行のコード span を落とす (中身の記法は本文ではない)。 */
function withoutCodeBlocks(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/``[\s\S]*?``/g, "");
}

/** コード例の中の記法は参照ではないので、リンク検査の前に落とす。 */
function proseOf(text) {
  return withoutCodeBlocks(text).replace(/`[^`\n]*`/g, "");
}

/**
 * リンクの参照先。title (`[t](url "title")`) と angle (`[t](<url with space>)`) も GitHub の記法として通す。
 * ここを狭めると、その形式で書いたリンクが無検査で残る。
 */
const linkPattern = /\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

function checkFile(file) {
  const text = readFileSync(file, "utf8");
  const shown = relative(root, file);

  for (const [, raw] of proseOf(text).matchAll(linkPattern)) {
    const target = raw.startsWith("<") ? raw.slice(1, -1) : raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
    const [path, anchor] = target.split("#");
    const resolved = path === "" ? file : resolve(dirname(file), path);
    if (path !== "" && (relative(root, resolved).startsWith("..") || !existsSync(resolved))) {
      if (path !== "" && relative(root, resolved).startsWith("..")) {
        skippedOutOfRoot += 1;
      } else {
        errors.push(`${shown}: リンク先がない → ${target}`);
      }
      continue;
    }
    if (anchor && resolved.endsWith(".md") && !hasHeading(resolved, anchor)) {
      errors.push(`${shown}: 見出しがない → ${target}`);
    }
  }

  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    if (!pathPattern.test(token) || pathAllowlist.has(token)) continue;
    if (!existsSync(join(root, token))) errors.push(`${shown}: パスがない → ${token}`);
  }

  // 見出しはアンカーとして外部から参照される。UI の階層を書くと、階層が変わるたびにリンクが死ぬ。
  // 見出しの中の単一のコード span は見出しの一部なので、コードブロックと複数行のコード span だけを外して判定する
  for (const [, heading] of withoutCodeBlocks(text).matchAll(/^#{1,6}[ \t]+(.*)$/gm)) {
    if (heading.includes("→")) errors.push(`${shown}: 見出しに「→」を書かない → ${heading}`);
  }

  const budget = DOC_LINE_BUDGET[shown];
  if (budget !== undefined) {
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (lines > budget) {
      errors.push(`${shown}: 行数 ${lines} が予算 ${budget} を超えている (予算を上げるなら diff に出す)`);
    }
  }
}

function collectSources(target) {
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const child = join(target, entry.name);
    if (entry.isDirectory()) return collectSources(child);
    return /\.(?:tsx?|mjs)$/.test(entry.name) ? [child] : [];
  });
}

function checkSource(file) {
  const shown = relative(root, file);
  for (const [, doc, anchor] of readFileSync(file, "utf8").matchAll(sourceDocRef)) {
    const resolved = join(root, "docs", doc);
    if (!existsSync(resolved)) {
      errors.push(`${shown}: docs の参照先がない → docs/${doc}`);
    } else if (!hasHeading(resolved, anchor)) {
      errors.push(`${shown}: docs の見出しがない → docs/${doc}#${anchor}`);
    }
  }
}

for (const target of scanTargets) {
  for (const file of collectMarkdown(target)) checkFile(file);
}
for (const target of sourceTargets) {
  for (const file of collectSources(join(root, target))) checkSource(file);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\ndocs check: ${errors.length} 件`);
  process.exit(1);
}
console.log(`docs check: ok${skippedOutOfRoot > 0 ? ` (project 外への参照 ${skippedOutOfRoot} 件は未検査)` : ""}`);
