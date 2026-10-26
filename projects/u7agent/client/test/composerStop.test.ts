// 入力欄の主ボタン (送信 / 停止) の描画契約。入れ替わる条件と、押せる位置・読み上げ名を react-dom/server で固定する。
// 実際の見た目 (主スロットの塗り / 控えの枠) と、送信直後の保留時間は GUI 受入で見る。
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

const stopAt = (html: string): number => html.indexOf('aria-label="停止');
const sendAt = (html: string): number => html.indexOf('aria-label="送信"');
/** 停止のボタンが主スロットか控えか (見た目の class ではなく印で見る) */
const stopSlot = (html: string): string | null =>
  /data-stop-slot="([a-z]+)"/.exec(startTag(html, stopAt(html)))?.[1] ?? null;
/** 開始タグが disabled か (className の `disabled:` と取り違えない) */
const isDisabled = (tag: string): boolean => /\sdisabled(?:="")?[\s>]/.test(tag);

const attachment = (status: Attachment["status"]): Attachment => ({
  id: "a1",
  sessionId: "s1",
  name: "notes.md",
  size: 1200,
  status,
  path: ".u7agent/uploads/s1/notes.md",
});

test("描画: 実行中で送るものが無いとき、送信と入れ替えて停止を主スロットに出す", () => {
  // What: 押せる操作が停止だけの状態で、↑ を残さない (残すと押しても何も起きない)。
  const html = render({ stopVisible: true });
  const stop = stopAt(html);
  assert.ok(stop >= 0, "停止を出す");
  assert.ok(sendAt(html) < 0, "送信は出さない");
  const tag = startTag(html, stop);
  assert.ok(tag.includes('type="button"'), "送信として submit させない");
  assert.equal(stopSlot(html), "primary", "主スロットの見た目にする");
  assert.ok(html.includes("実行を中断します"), "何が起きるかを title に持つ");
});

test("描画: 実行中でも送るものがあれば、送信を主に残して停止を控えとして並べる", () => {
  // What: 実行中の送信は待機キューへ積む経路なので、下書きがある間も停止を押せる位置に残す。
  const html = render({ stopVisible: true, suggestion });
  const stop = stopAt(html);
  const send = sendAt(html);
  assert.ok(stop >= 0 && send >= 0, "停止と送信の両方を出す");
  assert.ok(stop < send, "停止を送信の左へ並べる");
  assert.equal(stopSlot(html), "secondary", "主スロットの塗りは送信へ譲る");
  const sendTag = startTag(html, send);
  assert.ok(sendTag.includes('type="submit"'), "送信は submit のまま");
  assert.ok(!isDisabled(sendTag), "送れるものがあるので押せる");
  assert.ok(html.includes("待機キューに積んでから送信します"), "押したときの意味を送信の側に書く");
});

test("描画: 実行中でも添付（アップロード済み）があれば送信を主に残す", () => {
  // What: 送れるものの判定は本文 / 添付 / 定型チップの 3 経路。添付だけの送信も待機キューへ積める。
  const html = render({ stopVisible: true, attachments: [attachment("done")] });
  const send = sendAt(html);
  assert.ok(send >= 0, "送信を出す");
  assert.ok(!isDisabled(startTag(html, send)), "添付があるので押せる");
  assert.equal(stopSlot(html), "secondary", "停止は控えに残す");
});

test("描画: 添付のアップロード中は停止を主スロットへ上げない", () => {
  // What: アップロードが終われば送れるようになる (送信のスロットを先に破壊操作へ渡さない)。
  const html = render({ stopVisible: true, attachments: [attachment("uploading")] });
  assert.equal(stopSlot(html), "secondary", "停止は控えのまま");
  assert.ok(isDisabled(startTag(html, sendAt(html))), "送信はアップロードが終わるまで無効");
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
  assert.equal(stopSlot(html), "secondary", "停止を主スロットの見た目にしない");
  assert.ok(isDisabled(startTag(html, send)), "送信は無効のまま");
});

test("描画: 停止のラベルに待機件数を載せず、破棄する範囲だけを示す", () => {
  // What: 件数の正はコンポーザー直上のブロック。ボタンは押すと何が消えるかを読み上げ名と title で示す
  const html = render({ stopVisible: true, queueDepth: 2 });
  assert.ok(!html.includes(">停止<"), "可視のテキストリンクにしない");
  assert.ok(html.includes('aria-label="停止（待機中の送信も破棄）"'), "読み上げ名に破棄の対象を入れる");
  assert.ok(html.includes("実行を中断し、待機中の送信も破棄します"), "押すと何が消えるかを title に持つ");
  assert.ok(!html.includes("2 件"), "件数はブロックだけが持つ");

  // 待機が無ければ、破棄する待機が無いことをタイトルでも示さない
  assert.ok(render({ stopVisible: true }).includes("実行を中断します"));
});
