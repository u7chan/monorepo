// 入力欄の Enter の分け方。IME の変換確定 Enter を送信に使わないこと (desktop / compact 共通) と、
// compact の改行手段 (改行は Enter、送信はボタン) を固定する。jsdom を使わない方針のため、判定は
// 純関数で、入力欄の属性は react-dom/server で、event からの配線はソース走査で確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerProps } from "../src/components/Composer";
import { shouldSubmitOnEnter, type EnterKeyState } from "../src/lib/composerKeys";
import type { AgentDef } from "../src/types";

// Composer は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { Composer } = await import("../src/components/Composer");

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const enter = (overrides: Partial<EnterKeyState> = {}): EnterKeyState => ({
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  ...overrides,
});

test("desktop: 通常の Enter は送信する", () => {
  assert.equal(shouldSubmitOnEnter(enter(), "desktop"), true);
});

test("desktop: Shift+Enter は改行に残す", () => {
  assert.equal(shouldSubmitOnEnter(enter({ shiftKey: true }), "desktop"), false);
});

test("desktop: Enter 以外のキーは送信しない", () => {
  assert.equal(shouldSubmitOnEnter(enter({ key: "a" }), "desktop"), false);
});

test("IME: 変換中の Enter (isComposing) は送信しない", () => {
  assert.equal(shouldSubmitOnEnter(enter({ isComposing: true }), "desktop"), false);
  assert.equal(shouldSubmitOnEnter(enter({ isComposing: true }), "portrait"), false);
});

test("IME: compositionend が先に来た Enter (keyCode 229) も送信しない", () => {
  assert.equal(shouldSubmitOnEnter(enter({ keyCode: 229 }), "desktop"), false);
  assert.equal(shouldSubmitOnEnter(enter({ keyCode: 229 }), "portrait"), false);
});

test("IME: 変換中でない Enter は composition の後に来ても送信できる", () => {
  assert.equal(shouldSubmitOnEnter(enter({ isComposing: false, keyCode: 13 }), "desktop"), true);
});

test("compact: Enter は改行に残し、送信はボタンに任せる", () => {
  for (const mode of ["portrait", "landscape"] as const) {
    assert.equal(shouldSubmitOnEnter(enter(), mode), false, `${mode} の Enter は送信に使わない`);
    assert.equal(shouldSubmitOnEnter(enter({ shiftKey: true }), mode), false, `${mode} の Shift+Enter は改行`);
  }
});

const agent: AgentDef = { id: "general", name: "汎用アシスタント", description: "", systemPrompt: "", skillIds: [] };

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
  rootCwd: "/workspace",
  skills: { status: "unavailable" },
  onReloadSkills: () => {},
  onSend: () => {},
  onStop: () => {},
  onAttachFiles: () => {},
  onRemoveAttachment: () => {},
  onChangeModel: () => {},
  onChangeThinkingLevel: () => {},
  onChangeAgent: () => {},
};

const render = (overrides: Partial<ComposerProps> = {}): string =>
  renderToStaticMarkup(createElement(Composer, { ...props, ...overrides }));

test("描画: ソフトキーボードの Enter ラベルをモードの動作に合わせる", () => {
  // 属性名は HTML では大文字小文字を区別しない (SSR の文字列は prop 名のまま出る)
  assert.match(render(), /<textarea[^>]*enterkeyhint="send"/i, "desktop は送信キーにする");
  assert.match(render({ mode: "portrait" }), /<textarea[^>]*enterkeyhint="enter"/i, "compact は改行キーにする");
  assert.match(render({ mode: "landscape" }), /<textarea[^>]*enterkeyhint="enter"/i, "landscape も同じ");
});

test("描画: Enter で送信する説明は desktop だけに出す", () => {
  assert.ok(render().includes("Enterで送信"), "desktop は入力欄に送信の説明を出す");
  assert.ok(!render({ mode: "portrait" }).includes("Enterで送信"), "compact は Enter が改行なので出さない");
});

test("配線: 入力欄の keydown は共有の判定を通ってから送信する", () => {
  const composer = source("../src/components/Composer.tsx");
  const start = composer.indexOf("const handleKeyDown");
  // ハンドラの終わりの "};" は state リテラルにも現れるので、固定長で切り出す
  const handler = composer.slice(start, start + 400);

  assert.ok(handler.includes("shouldSubmitOnEnter("), "判定を Composer 側へ書き戻さない (docs/ui-layout.md)");
  assert.ok(
    handler.indexOf("shouldSubmitOnEnter") < handler.indexOf("preventDefault"),
    "判定より先に preventDefault しない (IME の変換確定を潰さない)",
  );
  assert.ok(handler.includes("event.nativeEvent"), "isComposing / keyCode は native のイベントから読む");
});
