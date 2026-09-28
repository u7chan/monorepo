// 要約済み / 除外の薄暗い表示の検証。DOM 基盤が無いため react-dom/server の静的描画で固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Bubble } from "../src/lib/chatTypes";

// MessageView は AttachedFiles 経由で api.ts (location.origin を読む) を辿るため、先に shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const { MessageView } = await import("../src/components/chat/MessageView");

function render(context: Bubble["context"]): string {
  const bubble: Bubble = {
    id: 1,
    entryId: "m1",
    context,
    role: "assistant",
    text: "本文",
    tools: [],
    skillLoads: [],
  };
  return renderToStaticMarkup(
    createElement(MessageView, {
      bubble,
      skillBadges: [],
      copied: false,
      compact: false,
      rootCwd: "/workspace",
      onCopy: () => {},
      copiedId: "",
      onCopyTool: () => {},
      copiedAll: false,
      onCopyAll: () => {},
    }),
  );
}

test("summarized のバブルは薄暗く表示し、要約済みタグを出す", () => {
  const html = render("summarized");
  assert.ok(html.includes("opacity-60"));
  assert.ok(html.includes("要約済み"));
  assert.ok(html.includes("要約に置き換わり"));
});

test("excluded のバブルは要約済みと区別したタグを出す", () => {
  const html = render("excluded");
  assert.ok(html.includes("opacity-60"));
  assert.ok(html.includes("除外"));
  assert.ok(!html.includes("要約済み"));
});

test("active のバブルはタグも薄暗い表示も付けない", () => {
  const html = render("active");
  assert.ok(!html.includes("opacity-60"));
  assert.ok(!html.includes("要約済み"));
  assert.ok(!html.includes("除外"));
});
