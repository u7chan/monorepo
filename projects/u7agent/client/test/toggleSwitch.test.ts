// 共有の ToggleSwitch (通知設定とプレビューのパス行が使う) の契約。DOM テスト基盤が無いため、
// 静的描画で寸法・状態の出し方を、ソース走査で押下の反転を固定する。
//   1. 既定 (size 省略 = md) は通知設定が使っていた寸法のまま (共有化で見た目を変えない)
//   2. size="sm" はプレビューのパス行 (ソース / プレビュー の切替) と同じ高さ
//   3. role="switch" / aria-checked で状態を出し、押下で checked を反転する
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToggleSwitch } from "../src/components/ToggleSwitch";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function render(props: { checked: boolean; size?: "md" | "sm"; disabled?: boolean }): string {
  return renderToStaticMarkup(createElement(ToggleSwitch, { label: "有効", onChange: () => {}, ...props }));
}

/** ボタンの class をトークンに分ける (部分一致だと gap-1.5 が gap-1 に一致して余白の回帰を見逃す) */
function buttonClasses(html: string): string[] {
  const match = html.match(/<button[^>]*class="([^"]*)"/);
  assert.ok(match, "スイッチの class が無い");
  return match[1].split(/\s+/);
}

test("既定は md の寸法で、通知設定の見た目を変えない", () => {
  const classes = buttonClasses(render({ checked: true }));
  for (const token of ["min-h-7.5", "gap-1.5", "px-2.5", "text-1xs"]) {
    assert.ok(classes.includes(token), `${token} が既定の寸法に無い`);
  }
  for (const token of ["min-h-5.5", "gap-1", "px-2", "text-3xs"]) {
    assert.ok(!classes.includes(token), `sm の寸法 ${token} が既定へ混ざっている`);
  }
  // 通知設定は size を渡さない (渡すと md の契約が変わる)
  assert.ok(
    !read("src/components/notifications/DiscordCard.tsx").includes("size="),
    "DiscordCard が size を渡している",
  );
});

test("sm はプレビューのパス行と同じ高さになる", () => {
  const classes = buttonClasses(render({ checked: false, size: "sm" }));
  for (const token of ["min-h-5.5", "gap-1", "px-2", "text-3xs"]) {
    assert.ok(classes.includes(token), `${token} が sm の寸法に無い`);
  }
  for (const token of ["min-h-7.5", "gap-1.5", "px-2.5", "text-1xs"]) {
    assert.ok(!classes.includes(token), `md の寸法 ${token} が sm へ混ざっている`);
  }
});

test("状態と無効を role=switch / aria-checked で出し、丸の印も切り替える", () => {
  assert.match(render({ checked: true }), /role="switch" aria-checked="true"/, "ON の状態を出していない");
  assert.match(render({ checked: false }), /role="switch" aria-checked="false"/, "OFF の状態を出していない");
  assert.match(render({ checked: true }), /class="dot dot-accent"/, "ON の印が違う");
  assert.match(render({ checked: false }), /class="dot dot-idle"/, "OFF の印が違う");
  assert.match(render({ checked: false, disabled: true }), /disabled=""/, "無効を出していない");
});

test("押下は checked を反転し、狭い行でも潰れない", () => {
  const source = read("src/components/ToggleSwitch.tsx");
  assert.match(source, /onClick=\{\(\) => onChange\(!checked\)\}/, "押下が状態の反転になっていない");
  assert.match(source, /onChange: \(checked: boolean\) => void/, "コールバックの契約が違う");
  // パス行は flex の 1 行なので、縮むとスイッチが潰れる
  assert.ok(source.includes("shrink-0"), "shrink-0 が無い");
});
