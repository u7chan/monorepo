// 共通の確認ダイアログ。文言は各 lib の純関数、見た目はここ (静的描画) で固定する。
// 開閉・焦点・Escape はブラウザで確認する (docs/testing.md の GUI の最小受入)。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { renameInputValue, type ConfirmRequest, type PromptRequest } from "../src/lib/confirmDialog";

const longTitle = "決済画面の検証".repeat(12);

const confirmRequest: ConfirmRequest = {
  kind: "confirm",
  title: "サービスを起動",
  body: ["他会話のサービスを停止して、この会話のサービスを起動します。"],
  subject: { label: "停止する会話", value: longTitle },
  code: { label: "起動コマンド", value: "pnpm dev" },
  notes: ["エージェントが実行中です。"],
  confirmLabel: "停止して起動",
};

test("確認は見出し・対象の行・等幅の行・補足・ボタンを出す", () => {
  const html = renderToStaticMarkup(
    createElement(ConfirmDialog, { request: confirmRequest, onConfirm: () => {}, onCancel: () => {} }),
  );

  assert.match(html, /<dialog[^>]*aria-modal="true"[^>]*aria-label="サービスを起動"/);
  assert.ok(html.includes("停止する会話"), "対象の行のラベルが無い");
  // 長い対象名は 2 行で clamp し、全文は title 属性で読める
  assert.match(html, /class="[^"]*line-clamp-2[^"]*"[^>]*title="決済画面の検証/);
  assert.ok(html.includes("<code"), "起動コマンドを等幅で出していない");
  assert.ok(html.includes("pnpm dev"));
  assert.ok(html.includes("エージェントが実行中です。"), "補足が無い");
  assert.match(html, />キャンセル</);
  assert.match(html, />停止して起動</);
});

test("prompt は入力欄に現在値を入れ、ラベルと確定ボタンを持つ", () => {
  const request: PromptRequest = {
    kind: "prompt",
    title: "名前を変更",
    subject: { label: "名前を変更するフォルダ", value: "docs" },
    label: "新しい名前",
    defaultValue: "docs",
    confirmLabel: "名前を変更",
  };
  const html = renderToStaticMarkup(createElement(ConfirmDialog, { request, onConfirm: () => {}, onCancel: () => {} }));

  assert.match(html, /<input[^>]*value="docs"/);
  assert.ok(html.includes("新しい名前"));
  assert.match(html, />名前を変更</);
});

test("リネームの入力は取り消し・空・未変更を何もしない扱いにする", () => {
  assert.equal(renameInputValue("新しい名前", "古い名前"), "新しい名前");
  assert.equal(renameInputValue(null, "古い名前"), undefined, "取り消し");
  assert.equal(renameInputValue("", "古い名前"), undefined, "空");
  assert.equal(renameInputValue("古い名前", "古い名前"), undefined, "未変更");
});

// ネイティブの確認は見た目も焦点も制御できず、文言も DOM が無いと検証できない。
// 呼び出しが戻らないよう、確認は共通ダイアログだけを通す契約を source scan で固定する。
test("client はネイティブの confirm / prompt / alert を呼ばない", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => /\.tsx?$/.test(name));
  assert.ok(files.length > 0, "走査対象が無い");

  for (const name of files) {
    const source = readFileSync(join(root, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const token of ["window.confirm(", "window.prompt(", "window.alert("]) {
      assert.ok(!source.includes(token), `src/${name} に ${token} がある`);
    }
  }
});
