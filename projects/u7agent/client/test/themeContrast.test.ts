// テーマの文字色が「小さい文字」の受入条件 (4.5:1) を満たすことを、通常面だけでなく hover 面・
// 選択面 (accent-wash)・状態ラベルの淡い面 (warn / accent の 10%) でも固定する。
// サイドバーの選択行は panel に accent-wash、さらにバッジの 10% を重ねた二重合成になるため、
// その実効背景も同じ計算で検査する。
// 色は CSS のテーマトークンを入力にした計算で検査する (見た目の調整ではなく、読みやすさの契約)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles/index.css"), "utf8");

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `fg` を不透明度 `alpha` で `bg` に重ねた実効色 (CSS の rgba と同じ合成) */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((channel, index) => channel * alpha + bg[index] * (1 - alpha)) as Rgb;
}

type Theme = {
  name: string;
  color: Record<string, Rgb>;
  wash: { color: Rgb; alpha: number };
};

function parseThemes(source: string): Theme[] {
  const blocks = source.matchAll(/(?::root,\s*)?\[data-theme="([\w-]+)"\]\s*\{([\s\S]*?)\n\}/g);
  return [...blocks].map(([, name, body]) => {
    const color: Record<string, Rgb> = {};
    for (const match of body.matchAll(/--c-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) color[match[1]] = toRgb(match[2]);
    const wash = body.match(/--c-accent-wash:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    assert.ok(wash, `${name}: --c-accent-wash が rgba で定義されていない`);
    return {
      name,
      color,
      wash: {
        color: [Number(wash[1]) / 255, Number(wash[2]) / 255, Number(wash[3]) / 255],
        alpha: Number(wash[4]),
      },
    };
  });
}

/**
 * 11px の文字が載り得る面。hover は CSS 遷移後の実効背景で、選択面は accent-wash を親面へ重ねた
 * 実効色、状態ラベルは warn / accent を 10% 重ねた実効色。
 */
function surfacesOf(theme: Theme): Record<string, Rgb> {
  const plain: Record<string, Rgb> = {
    raised: theme.color.raised,
    soft: theme.color.soft,
    hover: theme.color.hover,
    base: theme.color.base,
    panel: theme.color.panel,
  };
  const surfaces: Record<string, Rgb> = { ...plain };
  for (const [name, background] of Object.entries(plain)) {
    surfaces[`wash/${name}`] = over(theme.wash.color, background, theme.wash.alpha);
  }
  for (const name of ["soft", "hover"]) {
    surfaces[`warn10/${name}`] = over(theme.color.warn, plain[name], 0.1);
    surfaces[`accent10/${name}`] = over(theme.color.accent, plain[name], 0.1);
  }
  return surfaces;
}

/** 文字用トークン → その文字が実際に載る面 (全トークンを全面に当てない) */
const TOKEN_SURFACES: Record<string, string[]> = {
  // 行・入口のメタ文字
  "ink-soft": ["raised", "soft", "hover", "base", "panel", "wash/raised", "wash/panel", "wash/soft", "wash/base"],
  // 実行中ラベル・入口・リンク
  "accent-text": [
    "raised",
    "soft",
    "hover",
    "base",
    "panel",
    "wash/raised",
    "wash/panel",
    "wash/soft",
    "wash/base",
    "accent10/soft",
    "accent10/hover",
  ],
  // 回答待ちラベル (サイドバーは warn 10% の面に載る)
  "warn-text": ["raised", "soft", "hover", "wash/raised", "wash/panel", "wash/soft", "warn10/soft", "warn10/hover"],
  // 完了 / 失敗ラベル (実行状況の行は raised と hover だけ)
  "ok-text": ["raised", "hover"],
  "danger-text": ["raised", "hover"],
};

const THEME_NAMES = ["midnight", "daylight", "mocha", "forest", "sakura", "sky"];

test("小さい文字の文字用トークンは、通常面 / hover 面 / 淡い面で 4.5:1 以上", () => {
  const themes = parseThemes(css);
  // テーマを増やしたらこの検査対象も増やす (色の契約を素通りさせない)
  assert.deepEqual(
    themes.map((theme) => theme.name),
    THEME_NAMES,
  );
  for (const theme of themes) {
    const surfaces = surfacesOf(theme);
    for (const [token, names] of Object.entries(TOKEN_SURFACES)) {
      const color = theme.color[token];
      assert.ok(color, `${theme.name}: --c-${token} が定義されていない`);
      for (const name of names) {
        const ratio = contrast(color, surfaces[name]);
        assert.ok(ratio >= 4.5, `${theme.name}: ${token} on ${name} = ${ratio.toFixed(3)}:1 (4.5:1 以上が必要)`);
      }
    }
  }
});

test("状態ラベルの面は hover で通常面と異なり、4.5:1 の検査から外れていない", () => {
  // hover を通常面と同じ色にすると検査は通るが、行の hover フィードバックが消える。
  // この画面の行は hover で背景を変えるため、遷移後の面も必ず検査対象にする。
  for (const theme of parseThemes(css)) {
    assert.notDeepEqual(theme.color.hover, theme.color.raised, `${theme.name}: hover と raised が同じ`);
    const surfaces = surfacesOf(theme);
    for (const token of ["ink-soft", "accent-text", "warn-text", "ok-text", "danger-text"]) {
      assert.ok(TOKEN_SURFACES[token].includes("hover"), `${token}: hover 面が検査対象に無い`);
      assert.ok(contrast(theme.color[token], surfaces.hover) >= 4.5, `${theme.name}: ${token} on hover`);
    }
  }
});

test("選択行の 10px バッジとメタは、panel + accent-wash + 10% の実効背景でも 4.5:1 以上", () => {
  for (const theme of parseThemes(css)) {
    // SessionRow の選択行: bg-panel の上に bg-accent-wash、バッジはさらに bg-warn/10 などを重ねる。
    const selected = over(theme.wash.color, theme.color.panel, theme.wash.alpha);
    for (const [token, tint] of [
      ["warn-text", theme.color.warn],
      ["accent-text", theme.color.accent],
      ["ok-text", theme.color.ok],
    ] as const) {
      const badge = over(tint, selected, 0.1);
      // 10% の面が選択面と同色になっていないこと (検査が素通りしないようにする)
      assert.notDeepEqual(badge, selected, `${theme.name}: ${token} のバッジ面が選択面と同じ`);
      const ratio = contrast(theme.color[token], badge);
      assert.ok(ratio >= 4.5, `${theme.name}: ${token} on 選択行のバッジ = ${ratio.toFixed(3)}:1 (4.5:1 以上が必要)`);
    }
    // 選択行の 10px メタは ink-muted ではなく ink-soft を使う (SessionRow の選択分岐)
    const meta = contrast(theme.color["ink-soft"], selected);
    assert.ok(meta >= 4.5, `${theme.name}: 選択行の 10px メタ (ink-soft) = ${meta.toFixed(3)}:1 (4.5:1 以上が必要)`);
  }
});
