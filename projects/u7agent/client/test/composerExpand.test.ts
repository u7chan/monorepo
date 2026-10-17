// 入力欄の拡大の描画契約。開閉・アニメーション・焦点・Escape は実 DOM が要るため GUI 受入で見て、
// ここでは読み上げに効く 2 点 (畳んだ外装を dialog として露出しない / 拡大のボタンの読み上げ名と状態) だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerProps } from "../src/components/Composer";
import type { AgentDef } from "../src/types";

// Composer は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { Composer } = await import("../src/components/Composer");

const agent: AgentDef = { id: "general", name: "汎用アシスタント", description: "", systemPrompt: "" };

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

/** 開始タグ (`<dialog …>` / `<button …>`) を行頭の位置から `>` まで切り出す */
const startTag = (html: string, index: number): string =>
  html.slice(html.lastIndexOf("<", index), html.indexOf(">", index) + 1);

test("描画: 畳んだ外装は dialog として露出しない", () => {
  const html = render();
  const dialog = html.indexOf("<dialog");
  assert.ok(dialog >= 0, "外装は dialog で置く (拡大で top layer へ移すため)");
  const tag = startTag(html, dialog);
  assert.ok(tag.includes('role="presentation"'), "閉じた dialog を区切りとして読み上げさせない");
  assert.ok(!tag.includes("aria-label"), "閉じた外装に dialog の名前を与えない");
});

test("描画: 拡大のボタンは読み上げ名と状態を持ち、入力欄の枠の中にある", () => {
  const html = render();
  const button = html.indexOf('aria-label="入力欄を拡大"');
  assert.ok(button >= 0, "読み上げ名を持つ");
  const tag = startTag(html, button);
  assert.ok(tag.includes('type="button"'), "送信ボタンにしない");
  assert.ok(tag.includes('aria-expanded="false"'), "畳んだ状態を示す");
  assert.ok(html.indexOf("<form") < button, "入力欄の枠の中に置く");
});
