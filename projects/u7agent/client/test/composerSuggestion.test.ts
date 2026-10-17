// 選択中の定型プロンプト (チップ) の描画。置き場所と送信ボタンの活性条件を react-dom/server で固定する。
// クリック / backspace / 送信の動きは実 DOM が要るため、判定は suggestion.test.ts、見た目は GUI 受入で見る。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerProps } from "../src/components/Composer";
import type { Attachment } from "../src/lib/attachments";
import type { AgentDef, AgentSuggestion } from "../src/types";

// Composer は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { Composer } = await import("../src/components/Composer");

const agent: AgentDef = { id: "general", name: "汎用アシスタント", description: "", systemPrompt: "" };
const suggestion: AgentSuggestion = { label: "ゲームを作る", prompt: "ゲーム作りの相棒になって" };
const attachment: Attachment = {
  id: "a1",
  sessionId: "",
  name: "game-design.md",
  size: 1024,
  status: "done",
  path: "uploads/game-design.md",
};

const props: ComposerProps = {
  activity: "",
  runtimeReady: true,
  sending: false,
  stopVisible: false,
  queueDepth: 0,
  settings: {
    modelOptions: [],
    supportsThinking: false,
    thinkingLevels: [],
    disabled: false,
    changing: false,
    compactDisabled: false,
  },
  agents: [agent],
  agentId: agent.id,
  mode: "desktop",
  attachments: [],
  suggestion: null,
  rootCwd: "/workspace",
  skills: { status: "unavailable" },
  // ライブのツール行は出さない (実行中のカードが無い状態)
  liveTools: { rows: [], hidden: 0, phase: "hidden" },
  onReloadSkills: () => {},
  onSend: () => {},
  onStop: () => {},
  onAttachFiles: () => {},
  onRemoveAttachment: () => {},
  onClearSuggestion: () => {},
  onChangeModel: () => {},
  onChangeThinkingLevel: () => {},
  onChangeAgent: () => {},
};

const render = (overrides: Partial<ComposerProps> = {}): string =>
  renderToStaticMarkup(createElement(Composer, { ...props, ...overrides }));

/** 本文 (textarea) を包む入力行の開始位置。「チップが入力行の中か」の境目に使う */
const inputRowStart = (html: string): number => html.lastIndexOf("<div", html.indexOf("<textarea"));

/** 送信ボタンの開始タグ (活性条件を disabled 属性で見る)。className にも `disabled:` があるため属性名で見る */
const sendButtonTag = (html: string): string => {
  const aria = html.indexOf('aria-label="送信"');
  return html.slice(html.lastIndexOf("<button", aria), html.indexOf(">", aria) + 1);
};

const sendDisabled = (html: string): boolean => sendButtonTag(html).includes(' disabled=""');

test("描画: desktop は入力行の中 (本文の左) にチップを出す", () => {
  const html = render({ suggestion });
  const chip = html.indexOf(suggestion.label);
  assert.ok(chip >= 0, "チップを出す");
  assert.ok(html.includes('aria-label="ゲームを作る を外す"'), "× を出して外せるようにする");
  assert.ok(html.indexOf("<form") < chip, "入力欄の枠の中に出す");
  assert.ok(inputRowStart(html) < chip && chip < html.indexOf("<textarea"), "本文と同じ入力行に置く");
});

test("描画: singleColumn は添付行と入力行の間 (枠の中) にチップを出す", () => {
  const html = render({ mode: "portrait", suggestion, attachments: [attachment] });
  const attach = html.indexOf(attachment.name);
  const chip = html.indexOf(suggestion.label);
  assert.ok(attach >= 0, "添付行を出す");
  assert.ok(attach < chip, "添付行より後ろに出す");
  assert.ok(chip < inputRowStart(html), "入力行より前 = 枠の中の上段に出す");
});

test("描画: チップが無いときは出さず、プレースホルダは元に戻る", () => {
  const html = render();
  assert.ok(!html.includes(suggestion.label), "チップを出さない");
  assert.ok(html.includes("メッセージを入力… (Enterで送信 / Shift+Enterで改行)"), "desktop のプレースホルダへ戻す");
  assert.ok(render({ mode: "portrait" }).includes("メッセージを入力…"), "singleColumn も戻す");
});

test("描画: チップがあるときのプレースホルダは「続きを入力…」", () => {
  assert.ok(render({ suggestion }).includes("続きを入力…"), "本文を足す前提の文言にする");
});

test("描画: 本文が空でもチップだけで送信ボタンが有効になる", () => {
  assert.equal(sendDisabled(render({ suggestion })), false, "チップを送信の条件に足す");
  assert.equal(sendDisabled(render()), true, "何も無ければ無効のまま");
  assert.equal(sendDisabled(render({ attachments: [attachment] })), false, "添付だけの送信は元から有効");
});
