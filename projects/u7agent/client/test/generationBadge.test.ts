// 本文の上の生成バッジ（案B）の描画検証。DOM 基盤が無いため react-dom/server の静的描画で固定する
// （ToolHistoryView の前例 client/test/liveToolCall.test.ts と同じ手法）。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Bubble } from "../src/lib/chatTypes";
import type { ToolCard } from "../src/lib/chatTypes";
import { GenerationBadgeList } from "../src/components/chat/GenerationBadgeList";

// MessageView は AttachedFiles 経由で api.ts (location.origin を読む) を辿るため、先に shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const { MessageView } = await import("../src/components/chat/MessageView");

const IMAGE_OUTPUT =
  "モデル: openai/gpt-image-2\n画像を生成して保存しました: generated/cat.png\n本文に示すときは Markdown 画像で示してください。";

const SPEECH_OUTPUT =
  "モデル: google/gemini-3.8-flash-tts\nボイス: Kore\n音声を生成して保存しました: generated/intro.mp3\n本文に示すときは、このパスを示してください。";

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "generate_image", args: "{}", phase: "done", output: IMAGE_OUTPUT, ...overrides };
}

function renderBadges(cards: ToolCard[], compact = false): string {
  return renderToStaticMarkup(createElement(GenerationBadgeList, { cards, compact }));
}

function renderMessage(bubble: Bubble): string {
  return renderToStaticMarkup(
    createElement(MessageView, {
      bubble,
      skillBadges: [],
      copied: false,
      compact: false,
      rootCwd: "",
      onCopy: () => {},
      copiedId: "",
      copyFailure: () => undefined,
      onCopyTool: () => {},
      copiedAll: false,
      onCopyAll: () => {},
    }),
  );
}

test("種類・モデル・保存パスを出し、長い値の全文は title に残す", () => {
  const image = renderBadges([card()]);
  assert.ok(image.includes("画像"), "種類が出る");
  assert.ok(image.includes(">openai/gpt-image-2<"));
  assert.ok(image.includes('title="openai/gpt-image-2"'));
  assert.ok(image.includes(">generated/cat.png<"));
  assert.ok(image.includes('title="generated/cat.png"'));
  assert.equal(image.includes("ボイス"), false, "画像にボイスは出さない");

  const speech = renderBadges([card({ name: "generate_speech", output: SPEECH_OUTPUT })]);
  assert.ok(speech.includes("音声"));
  assert.ok(speech.includes("google/gemini-3.8-flash-tts"));
  assert.ok(speech.includes("ボイス Kore"));
  assert.ok(speech.includes("generated/intro.mp3"));
});

test("長いボイスでも値を省略し、全文は title で読める", () => {
  // 宣言が無いモデルでは任意の長さのボイスを指定できる。狭い幅では値が幅 0 まで縮むため、全文を title に残す
  const voice = `voice-${"v".repeat(120)}`;
  const html = renderBadges([card({ name: "generate_speech", output: SPEECH_OUTPUT.replace("Kore", voice) })]);
  assert.ok(html.includes(`title="ボイス ${voice}"`), "ボイスの全文が出る");
  assert.ok(html.includes('title="google/gemini-3.8-flash-tts"'), "モデルも省略時は全文を title で読める");
  assert.ok(html.includes('title="generated/intro.mp3"'), "保存パスも省略時は全文を title で読める");
});

test("生成が無いターンではバッジ行を出さない", () => {
  assert.equal(renderBadges([]), "");
  assert.equal(renderBadges([card({ name: "bash", output: "ok" })]), "");
  assert.equal(renderBadges([card({ phase: "failed", output: "画像生成が混雑しています" })]), "");
  assert.equal(renderBadges([card({ output: "画像を生成して保存しました: generated/legacy.png" })]), "");
});

test("同じターンの複数の生成を件数の上限なく並べる", () => {
  const html = renderBadges([
    card({ id: "t1" }),
    card({ id: "t2", name: "generate_speech", output: SPEECH_OUTPUT }),
    card({ id: "t3", output: IMAGE_OUTPUT.replace("openai/gpt-image-2", "x-ai/grok-image") }),
  ]);
  assert.deepEqual(html.match(/data-generation-kind="[a-z]+"/g) ?? [], [
    'data-generation-kind="image"',
    'data-generation-kind="speech"',
    'data-generation-kind="image"',
  ]);
  for (const model of ["openai/gpt-image-2", "google/gemini-3.8-flash-tts", "x-ai/grok-image"]) {
    assert.ok(html.includes(model), `${model} が出る`);
  }
});

test("描画: MessageView は本文の上に生成バッジを出し、スキル読み込みバッジと並べる", () => {
  const bubble: Bubble = {
    id: 1,
    role: "assistant",
    text: "できました",
    tools: [card()],
    skillLoads: [],
  };
  const html = renderMessage(bubble);
  assert.ok(html.includes(">openai/gpt-image-2<"), "バッジが出る");
  assert.ok(html.indexOf("data-generation-kind") < html.indexOf("できました"), "本文より上に出る");

  const withoutGeneration = renderMessage({ ...bubble, tools: [card({ name: "bash", output: "ok" })] });
  assert.equal(withoutGeneration.includes("data-generation-kind"), false, "生成が無ければバッジは出ない");
});
