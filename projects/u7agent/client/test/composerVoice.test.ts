// 入力欄の音声の操作の描画契約。マイクを出す条件と、行の中での並び（[textarea] [マイク] [主ボタン]）を
// react-dom/server で固定する。録音中の主スロットの入れ替えは録音の状態機械に依存するため、
// 出し分けは client/test/composerAction.test.ts と client/test/voiceInputComposer.test.ts で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerProps } from "../src/components/Composer";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import type { AgentDef, AgentSuggestion } from "../src/types";

// Composer は api/http.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
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
  renderToStaticMarkup(createElement(ConfirmProvider, null, createElement(Composer, { ...props, ...overrides })));

const at = (html: string, label: string): number => html.indexOf(`aria-label="${label}"`);

test("描画: マイクは入力欄の行にだけ出し、textarea と主ボタンの間へ置く", () => {
  // What: 主ボタンの位置を動かさず、録音を始める導線を入力欄の隣に 1 つだけ置く
  const html = render({ voiceInputAvailable: true });
  const textarea = html.indexOf("<textarea");
  const mic = at(html, "音声入力を開始");
  const send = at(html, "送信");
  assert.ok(mic >= 0, "使えるときはマイクを出す");
  assert.ok(textarea < mic, "入力欄の後ろに置く");
  assert.ok(mic < send, "主ボタンの左に置く");
  assert.ok(html.includes("最大 120 秒"), "録音の上限を押す前に読める");
});

test("描画: マイクを使えないときは出さない", () => {
  // What: キー未設定・復号不能・非 secure context では押しても始まらないので、ボタン自体を出さない
  assert.equal(at(render(), "音声入力を開始"), -1);
  assert.equal(at(render({ voiceInputAvailable: false }), "音声入力を開始"), -1);
  assert.equal(at(render({ voiceInputAvailable: true }), "音声入力を開始") >= 0, true);
});

test("描画: 音声が待機なら主ボタンの出し分けは従来どおり", () => {
  // What: マイクが並んでも、送るものが無い実行中の ■ の主スロット入りは変えない
  const html = render({ voiceInputAvailable: true, stopVisible: true });
  const stop = html.indexOf('aria-label="停止');
  const mic = at(html, "音声入力を開始");
  assert.ok(stop >= 0, "停止を出す");
  assert.ok(mic < stop, "マイクを停止の左に置く");
  assert.match(html.slice(html.lastIndexOf("<", stop), html.indexOf(">", stop)), /data-stop-slot="primary"/);
  assert.equal(at(html, "送信"), -1, "押せる操作が停止だけなら ↑ を残さない");
});

test("描画: 添付はスキルの右へ移し、入力欄の行から外す", () => {
  // What: 入力欄の行を [textarea] [マイク] [主ボタン] に保ち、添付を右上の拡大ボタンと重ねない
  const html = render({ voiceInputAvailable: true, suggestion });
  const skill = at(html, "スキル一覧");
  const attach = at(html, "ファイルを添付");
  const textarea = html.indexOf("<textarea");
  assert.ok(skill >= 0 && attach >= 0, "スキルと添付を出す");
  assert.ok(skill < attach, "添付をスキルの右へ置く");
  assert.ok(attach < textarea, "添付を入力欄の行より上へ置く");
});

test("描画: 録音の操作は音声が待機の間は出さない", () => {
  // What: 待機中に ■ (実行の停止) と取り違える ● のボタンを残さない
  const html = render({ voiceInputAvailable: true });
  assert.equal(at(html, "録音を停止"), -1);
  assert.equal(at(html, "音声入力を取消"), -1);
  assert.equal(at(html, "文字起こしの確定待ち"), -1);
});
