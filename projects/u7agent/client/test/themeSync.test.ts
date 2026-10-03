import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  DEFAULT_THEME,
  SYSTEM_DARK_ID,
  SYSTEM_LIGHT_ID,
  THEME_STORAGE_KEY,
  THEMES,
  parseStoredThemeChoice,
} from "../src/theme/themes";

const initScript = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].split(",").map((selector) => selector.trim()),
  body: match[2],
}));

function initialTheme(
  choice: string | null,
  prefersLight: boolean,
  failures: { storage?: boolean; media?: boolean } = {},
): string | undefined {
  const dataset: { theme?: string } = {};
  runInNewContext(
    initScript,
    {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem: (key: string) => {
          assert.equal(key, THEME_STORAGE_KEY);
          if (failures.storage) throw new Error("SecurityError");
          return choice;
        },
      },
      window: {
        matchMedia: (query: string) => {
          assert.equal(query, "(prefers-color-scheme: light)");
          if (failures.media) throw new Error("unavailable");
          return { matches: prefersLight };
        },
      },
    },
    { timeout: 1_000 },
  );
  return dataset.theme;
}

test("初回描画前のスクリプトはすべての保存済みテーマを適用する", () => {
  for (const theme of THEMES) {
    assert.equal(initialTheme(theme.id, false), theme.id);
    assert.equal(initialTheme(theme.id, true), theme.id);
  }
});

test("system と不正な保存値は React 側と同じ OS テーマへ解決する", () => {
  assert.equal(DEFAULT_THEME, "system");
  for (const choice of [null, "", "system", "terminal", "MIDNIGHT"]) {
    assert.equal(parseStoredThemeChoice(choice), "system");
    assert.equal(initialTheme(choice, false), SYSTEM_DARK_ID);
    assert.equal(initialTheme(choice, true), SYSTEM_LIGHT_ID);
  }
  for (const theme of THEMES) assert.equal(parseStoredThemeChoice(theme.id), theme.id);
});

test("保存領域や OS テーマが使えなくても初期テーマを設定する", () => {
  assert.equal(initialTheme("sakura", true, { storage: true }), SYSTEM_LIGHT_ID);
  assert.equal(initialTheme(null, true, { media: true }), SYSTEM_DARK_ID);
  assert.equal(initialTheme(null, true, { storage: true, media: true }), SYSTEM_DARK_ID);
});

// CSS のキーと registry は型で結べないため、テーマ追加時の定義漏れだけ検査する。
test("CSS のプリセット・スウォッチのキーが registry と一致する", () => {
  const expected = THEMES.map((theme) => theme.id).sort();
  for (const pattern of [/^html\[data-theme="([^"]+)"\]$/, /^\.theme-swatch\[data-theme-id="([^"]+)"\]$/]) {
    const ids = rules
      .filter((rule) => rule.selectors.every((selector) => selector === ":root" || pattern.test(selector)))
      .flatMap((rule) => rule.selectors.flatMap((selector) => selector.match(pattern)?.[1] ?? []));
    assert.deepEqual(ids.sort(), expected);
  }
  for (const theme of THEMES) {
    const preset = rules.find((rule) => rule.selectors.includes(`html[data-theme="${theme.id}"]`));
    assert.equal(preset?.body.match(/color-scheme:\s*(light|dark)/)?.[1], theme.appearance, theme.id);
  }
});
