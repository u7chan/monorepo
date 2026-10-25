/**
 * README / AGENTS.md / docs の相対リンクと、本文中のリポジトリ内パスが実在することを検査する。
 *
 * `docs/design.md` は親リポジトリの設計ドラフトをそのまま写したもので、例示に他リポジトリのパスが
 * 含まれる。書き換えない前提なので検査対象から外す。
 *
 * project root の外を指すリンクは、monorepo の checkout でだけ検査する。Docker のビルドコンテキストには
 * project root しか入らないため、解決できないものは未検査として数える。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_TARGETS = ["README.md", "AGENTS.md", "docs"];
const EXCLUDED = new Set(["docs/design.md"]);
const PATH_PREFIXES = ["src/", "test/", "scripts/", "docs/"];
const FILE_PATTERN = /\.(?:tsx?|mjs|css|md|json|html|ya?ml)$/;

const errors = [];
let unchecked = 0;

function markdownFiles(target) {
  const path = resolve(root, target);

  if (!existsSync(path)) {
    return [];
  }

  if (statSync(path).isFile()) {
    return [path];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);

    if (entry.isDirectory()) {
      return markdownFiles(relative(root, child));
    }

    return entry.name.endsWith(".md") ? [child] : [];
  });
}

function withoutCode(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function checkLink(file, target) {
  const [pathPart] = target.split("#");

  if (pathPart === undefined || pathPart === "" || isExternal(target)) {
    return;
  }

  const resolved = resolve(dirname(file), decodeURIComponent(pathPart));
  const fromRoot = relative(root, resolved);

  if (fromRoot.startsWith("..")) {
    if (!existsSync(resolved)) {
      unchecked += 1;
    }

    return;
  }

  if (!existsSync(resolved)) {
    errors.push(`${relative(root, file)}: リンク先がありません: ${target}`);
  }
}

function checkPathToken(file, token) {
  const path = token.trim();

  if (!PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) || !FILE_PATTERN.test(path) || /\s/.test(path)) {
    return;
  }

  if (!existsSync(resolve(root, path))) {
    errors.push(`${relative(root, file)}: パスがありません: ${path}`);
  }
}

const files = SCAN_TARGETS.flatMap(markdownFiles).filter((file) => !EXCLUDED.has(relative(root, file)));

for (const file of files) {
  const text = readFileSync(file, "utf8");

  for (const match of withoutCode(text).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1]?.replace(/^<|>$/g, "");

    if (target !== undefined) {
      checkLink(file, target);
    }
  }

  for (const line of withoutCode(text).split("\n")) {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1];

      if (token !== undefined && !isExternal(token) && !token.startsWith("/")) {
        checkPathToken(file, token.split("#")[0] ?? token);
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }

  process.exit(1);
}

console.log(`docs:check ok (${files.length} files, ${unchecked} links outside the project root unchecked)`);
