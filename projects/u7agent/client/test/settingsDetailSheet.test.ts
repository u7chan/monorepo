import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SettingsDetailSheet } from "../src/components/SettingsDetailSheet";

test("詳細シートは名前付きのモーダルと終了操作、本文、状態通知を出す", () => {
  const html = renderToStaticMarkup(
    createElement(SettingsDetailSheet, {
      eyebrow: "AGENT",
      title: "エージェントを編集",
      onClose: () => {},
      note: { text: "保存できませんでした", error: true },
      children: "編集中の本文",
    }),
  );
  assert.match(html, /<dialog[^>]*aria-modal="true"[^>]*aria-label="エージェントを編集"/);
  assert.match(html, /<button[^>]*>[\s\S]*?閉じる<\/button>/);
  assert.ok(html.includes("編集中の本文"));
  assert.match(html, /aria-live="polite"/);
  assert.ok(html.includes("保存できませんでした"));
});
