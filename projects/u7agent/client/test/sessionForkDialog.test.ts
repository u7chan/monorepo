// 会話の分岐の専用ダイアログ。ヘッダーの閉じる (X) と、注記を上に置くフッターの並びを静的描画で固定する。
// 初期焦点・Escape・タップ領域はブラウザーで確認する (docs/testing.md)。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { SessionForkDialogProps } from "../src/components/SessionForkDialog";
import type { AgentDef } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { SessionForkDialog } = await import("../src/components/SessionForkDialog");
const { sessionForkDialogText } = await import("../src/lib/sessionFork");
const { handoffAgentChoices } = await import("../src/lib/sessionHandoff");

const general: AgentDef = { id: "general", name: "汎用アシスタント", description: "", systemPrompt: "" };
const research: AgentDef = { ...general, id: "research", name: "調査" };

function render(overrides: Partial<SessionForkDialogProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionForkDialog, {
      text: sessionForkDialogText("決済画面の検証"),
      agents: handoffAgentChoices([general, research], general.id, general.name),
      blockedNote: "",
      onClose: () => {},
      onFork: async () => {},
      ...overrides,
    }),
  );
}

/** ヘッダーの閉じる。文字を持たないので読み上げ名で引く */
function closeButtonTag(html: string): string {
  const tag = html.match(/<button[^>]*aria-label="閉じる"[^>]*>/)?.[0];
  assert.ok(tag, "ヘッダーの閉じるが無い");
  return tag;
}

test("ヘッダーは X だけで閉じ、フッターはキャンセルと分岐を並べる", () => {
  const html = render();
  assert.ok(closeButtonTag(html).includes('title="閉じる"'), "hover の補助が無い");
  assert.equal(html.includes(">閉じる<"), false, "ヘッダーに閉じるの文字を置かない");
  const footer = html.slice(html.indexOf("<footer"));
  assert.ok(footer.indexOf(">キャンセル<") < footer.indexOf(">分岐する<"), "主操作がキャンセルの左にある");
});

test("注記はボタン行の上に置き、理由が長くてもボタンの位置を動かさない", () => {
  const html = render();
  const footer = html.slice(html.indexOf("<footer"));
  assert.ok(
    footer.indexOf("分岐した会話には分岐元のリンクが出ます。") <
      footer.indexOf('<div class="flex items-center justify-end'),
    "注記がボタン行の外 (上) に無い",
  );
});

test("実行できない理由は警告として上に出し、確定を無効にする", () => {
  const html = render({ blockedNote: "実行中・キュー待ちは分岐できません。" });
  assert.ok(html.includes('role="alert"'));
  const footer = html.slice(html.indexOf("<footer"));
  assert.ok(
    footer.indexOf("実行中・キュー待ちは分岐できません。") <
      footer.indexOf('<div class="flex items-center justify-end'),
    "理由がボタン行の外 (上) に無い",
  );
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
});
