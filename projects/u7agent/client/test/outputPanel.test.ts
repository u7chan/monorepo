// 設定の出力枠 (OutputPanel) の描画契約。全画面の読み面 (fill) では、ヘッダの操作と本文の
// スクロール領域を分ける。ヘッダまで流れると、閉じるボタンと表示切替が本文と一緒に消えて、
// Escape の無い実機では閉じる手段が見えなくなる。
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

const { OutputPanel } = await import("../src/components/OutputPanel");

function render(props: { fill?: boolean; children?: ReactNode } = {}): string {
  return renderToStaticMarkup(
    createElement(OutputPanel, {
      label: "本文",
      meta: "SKILL.md · 3 行",
      text: "body",
      copyLabel: "本文をコピー",
      actions: createElement("span", null, "切替"),
      ...props,
    }),
  );
}

test("fill ではヘッダの操作を本文のスクロール領域の外に置く", () => {
  const html = render({ fill: true, children: createElement("p", null, "本文") });
  const scrollAt = html.indexOf("overflow-y-auto");
  assert.ok(scrollAt > 0, "本文のスクロール領域が無い");
  // 閉じるボタン / 表示切替 / コピーは本文と一緒に流れない位置 (スクロール領域より前) に出す
  assert.ok(html.indexOf("切替") < scrollAt, "操作が本文のスクロール領域の中にある");
  assert.ok(html.indexOf("本文をコピー") < scrollAt, "コピーが本文のスクロール領域の中にある");
});

test("既定 (fill 無し) は従来どおり枠の高さを内容に合わせる", () => {
  const html = render({ children: createElement("p", null, "本文") });
  assert.ok(!html.includes("overflow-y-auto"), "スクロール領域を作っていない");
  assert.ok(!html.includes("min-h-0 flex-1 flex-col"), "枠が親いっぱいに広がっている");
});
