// テーマの定義は FOUC 対策 (React の外で data-theme を立てる classic script と、CSS プリセット) の
// 都合で複数ファイルに分かれる。ずれても型エラーにならないため、ここで突き合わせて固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_THEME,
  SYSTEM_DARK_ID,
  SYSTEM_LIGHT_ID,
  THEMES,
  parseStoredThemeChoice,
} from "../src/theme/themes";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const initScript = read("public/theme-init.js");
// コメントアウトされた宣言を「実際に効いている定義」と数えないよう、コメントは先に除去する
const indexCss = read("src/styles/index.css").replace(/\/\*[\s\S]*?\*\//g, "");

const themeIds = THEMES.map((theme) => theme.id);
const sorted = (values: string[]) => [...values].sort();

type CssRule = { selectors: string[]; body: string };

const THEME_SELECTOR = /^html\[data-theme="([^"]+)"\]$/;
const SWATCH_SELECTOR = /^\.theme-swatch\[data-theme-id="([^"]+)"\]$/;
const ROOT_SELECTOR = /^:root$/;

// ルールを「セレクタリスト + 本文」に分解する (@layer などの入れ子は内部のフラットなルールだけが取れる)
const cssRules: CssRule[] = [...indexCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].split(",").map((selector) => selector.trim()),
  body: match[2],
}));

/** テーマ定義用のルール (セレクタリスト全体が :root か pattern に一致するもの) だけを返す。
 *  `html[data-theme="x"] .foo { }` のようなスコープ付きルールを定義と数えないため、
 *  生テキストではなくルール境界で判定する。 */
function themeRules(pattern: RegExp): CssRule[] {
  return cssRules.filter((rule) =>
    rule.selectors.every((selector) => pattern.test(selector) || ROOT_SELECTOR.test(selector)),
  );
}

function idsOf(rules: CssRule[], pattern: RegExp): string[] {
  return rules.flatMap((rule) =>
    rule.selectors.flatMap((selector) => selector.match(pattern)?.[1] ?? []),
  );
}

const presetRules = themeRules(THEME_SELECTOR);

/** theme-init.js の `var NAME = ["a", "b"]` を読む */
function readInitArray(name: string): string[] {
  const match = initScript.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `theme-init.js に ${name} の定義が見つからない`);
  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** theme-init.js の `var NAME = "value"` を読む */
function readInitString(name: string): string {
  const match = initScript.match(new RegExp(`var ${name} = "([^"]*)"`));
  assert.ok(match, `theme-init.js に ${name} の定義が見つからない`);
  return match[1];
}

/** プリセット内の `color-scheme` を読む (midnight は :root と併記されるが同じルール) */
function readCssColorScheme(id: string): string {
  const selector = `html[data-theme="${id}"]`;
  const rule = presetRules.find((candidate) => candidate.selectors.includes(selector));
  assert.ok(rule, `index.css に ${selector} のプリセットが無い`);
  const scheme = rule.body.match(/color-scheme:\s*(light|dark)/);
  assert.ok(scheme, `index.css の ${id} に color-scheme が無い`);
  return scheme[1];
}

test("theme-init.js のテーマ id 一覧が themes.ts の THEMES と一致する", () => {
  assert.deepEqual(readInitArray("THEMES"), themeIds);
});

test("index.css の html[data-theme] プリセットが THEMES と一致する", () => {
  const ids = idsOf(presetRules, THEME_SELECTOR);
  // 並び順は問わない。重複があれば件数が合わず落ちる
  assert.deepEqual(sorted(ids), sorted(themeIds));
});

test("index.css の .theme-swatch が THEMES と一致する", () => {
  const rules = themeRules(SWATCH_SELECTOR);
  assert.deepEqual(sorted(idsOf(rules, SWATCH_SELECTOR)), sorted(themeIds));
});

test("index.css のプリセットの color-scheme が THEMES の appearance と一致する", () => {
  for (const theme of THEMES) {
    assert.equal(readCssColorScheme(theme.id), theme.appearance, `${theme.id} の color-scheme`);
  }
});

test("theme-init.js の system 解決 id が themes.ts と一致する", () => {
  assert.equal(readInitString("FALLBACK"), SYSTEM_DARK_ID);
  const light = initScript.match(/prefersLight \? "([^"]+)" : FALLBACK/);
  assert.ok(light, "theme-init.js に prefersLight の分岐が見つからない");
  assert.equal(light[1], SYSTEM_LIGHT_ID);
});

test("保存値の解決: 有効な id はそのまま、無効な値は system になる", () => {
  assert.equal(DEFAULT_THEME, "system");
  assert.equal(parseStoredThemeChoice("midnight"), "midnight");
  assert.equal(parseStoredThemeChoice("system"), "system");
  assert.equal(parseStoredThemeChoice(null), "system");
  // 削除済みテーマ (#1278 の terminal など) が残っていても system と同じ解決結果にする
  assert.equal(parseStoredThemeChoice("terminal"), "system");
  assert.equal(parseStoredThemeChoice(""), "system");
  assert.equal(parseStoredThemeChoice("MIDNIGHT"), "system");
});
