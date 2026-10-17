// 入力欄の主ボタン (送信 / 停止) の描画契約。入れ替わる条件と、押せる位置・読み上げ名を react-dom/server で固定する。
// 実際の見た目 (主スロットの塗り / 控えの枠) は GUI 受入で見る。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerProps } from "../src/components/Composer";
import type { AgentDef, AgentSuggestion } from "../src/types";

// Composer は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { Composer } = await import("../src/components/Composer");

const agent: AgentDef = { id: "general", name: "汎用アシスタント", description: "", systemPrompt: "", skillIds: [] };

/** 送れるものを 1 つ持たせるためのチップ (本文は state なので静的描画では入れられない) */
const suggestion: AgentSuggestion = { label: "表にする", prompt: "表にして" };

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

/** 開始タグ (`<button …>`) を、その位置より前の `<` から `>` まで切り出す */
const startTag = (html: string, index: number): string =>
  html.slice(html.lastIndexOf("<", index), html.indexOf(">", index) + 1);

const stopAt = (html: string): number => html.indexOf('aria-label="停止"');
const sendAt = (html: string): number => html.indexOf('aria-label="送信"');
/** 開始タグが disabled か (className の `disabled:` と取り違えない) */
const isDisabled = (tag: string): boolean => /\sdisabled(?:="")?[\s>]/.test(tag);

test("描画: 実行中で送るものが無いとき、送信と入れ替えて停止を主スロットに出す", () => {
  // What: 押せる操作が停止だけの状態で、↑ を残さない (残すと押しても何も起きない)。
  const html = render({ stopVisible: true });
  const stop = stopAt(html);
  assert.ok(stop >= 0, "停止を出す");
  assert.ok(sendAt(html) < 0, "送信は出さない");
  const tag = startTag(html, stop);
  assert.ok(tag.includes('type="button"'), "送信として submit させない");
  assert.ok(tag.includes("bg-accent"), "主スロットの見た目にする");
  assert.ok(html.includes("実行を中断します"), "何が起きるかを title に持つ");
});

test("描画: 実行中でも送るものがあれば、送信を主に残して停止を控えとして並べる", () => {
  // What: 実行中の送信は待機キューへ積む経路なので、下書きがある間も停止を押せる位置に残す。
  const html = render({ stopVisible: true, suggestion });
  const stop = stopAt(html);
  const send = sendAt(html);
  assert.ok(stop >= 0 && send >= 0, "停止と送信の両方を出す");
  assert.ok(stop < send, "停止を送信の左へ並べる");
  const stopTag = startTag(html, stop);
  assert.ok(!stopTag.includes("bg-accent"), "主スロットの塗りは送信へ譲る");
  assert.ok(stopTag.includes("border-line"), "控えの面 (枠だけ) にする");
  const sendTag = startTag(html, send);
  assert.ok(sendTag.includes('type="submit"'), "送信は submit のまま");
  assert.ok(!isDisabled(sendTag), "送れるものがあるので押せる");
  assert.ok(html.includes("待機キューに積んでから送信します"), "押したときの意味を送信の側に書く");
});

test("描画: 実行中でなければ停止を出さない", () => {
  // What: 停止できない状態で ■ を出すと、押しても何も起きないボタンになる。
  const html = render({ suggestion });
  assert.ok(stopAt(html) < 0, "停止を出さない");
  assert.ok(sendAt(html) >= 0, "送信は出す");
});

test("描画: 回答待ち (送信が止まっている) では停止を主スロットへ上げない", () => {
  // What: 主スロットの下の理由が「上の質問に回答してください」なのに、その隣で破壊操作を主役にしない。
  const html = render({
    stopVisible: true,
    settings: { ...props.settings, sendBlockedReason: "上の質問に回答してください（1件）" },
  });
  const stop = stopAt(html);
  const send = sendAt(html);
  assert.ok(stop >= 0, "停止は押せる位置に残す");
  assert.ok(send >= 0, "送信のスロットは残す (理由を添える先を消さない)");
  assert.ok(!startTag(html, stop).includes("bg-accent"), "停止を主スロットの見た目にしない");
  assert.ok(isDisabled(startTag(html, send)), "送信は無効のまま");
});

test("描画: 停止の待機件数は、ボタンのラベルではなく title で補う", () => {
  // What: 待機件数は状態行 (実行中… · 待機 N 件) とバブルのチップにも出るため、ボタンには載せない。
  const html = render({ stopVisible: true, queueDepth: 2 });
  assert.ok(!html.includes(">停止<"), "可視のテキストリンクにしない");
  assert.ok(html.includes("待機中の 2 件も破棄します"), "押すと何が消えるかを title に持つ");
});
