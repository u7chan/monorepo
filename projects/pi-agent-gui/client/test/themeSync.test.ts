// theme-init.js は CSP 対応のため React の外にあり theme 一覧を二重に持つ。ID がずれると
// 初期描画だけ別テーマになる (FOUC) ため、定義の同期をここで固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { THEMES } from "../src/theme/themes";

const initScript = readFileSync(
  fileURLToPath(new URL("../public/theme-init.js", import.meta.url)),
  "utf8",
);

function readArray(name: string): string[] {
  const match = initScript.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `theme-init.js に ${name} の定義が見つからない`);
  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

test("theme-init.js のテーマ一覧が themes.ts と一致する", () => {
  assert.deepEqual(readArray("THEMES"), THEMES.map((theme) => theme.id));
});

test("theme-init.js の light 判定が themes.ts の appearance と一致する", () => {
  const lightIds = THEMES.filter((theme) => theme.appearance === "light").map((theme) => theme.id);
  assert.deepEqual(readArray("LIGHT_THEMES"), lightIds);
});
