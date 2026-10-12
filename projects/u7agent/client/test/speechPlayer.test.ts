// 生成音声のプレイヤー（本文の直後の <audio controls>）の検証。DOM 基盤が無いため react-dom/server の
// 静的描画で固定する（音声プレビューの前例 client/test/filePreviewStorageMode.test.ts と同じ手法）。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Bubble, ToolCard } from "../src/lib/chatTypes";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { fileRawUrl } = await import("../src/api");
const { SpeechPlayerList } = await import("../src/components/chat/SpeechPlayerList");
// MessageView は AttachedFiles 経由で api.ts を辿る
const { MessageView } = await import("../src/components/chat/MessageView");

const VERSION = 7;
const rawUrl = (path: string): string => fileRawUrl(path, VERSION);

const IMAGE_OUTPUT =
  "モデル: openai/gpt-image-2\n画像を生成して保存しました: generated/cat.png\n" +
  "本文に示すときは Markdown 画像で示してください。";

const SPEECH_OUTPUT =
  "モデル: google/gemini-3.8-flash-tts\nボイス: Kore\n" +
  "音声を生成して保存しました: generated/intro.mp3\n" +
  "本文に示すときは、このパス (generated/intro.mp3) を示してください。";

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "generate_speech", args: "{}", phase: "done", output: SPEECH_OUTPUT, ...overrides };
}

/** audio 要素の開始タグ。属性の並びに依存しないよう、タグ単位で取り出す */
function audioTags(html: string): string[] {
  return [...html.matchAll(/<audio\b[^>]*>/g)].map((match) => match[0]);
}

/** タグの src を URL として読む (React は属性の & を &amp; へ写す) */
function audioSrc(tag: string): URL {
  const value = tag.match(/src="([^"]+)"/)?.[1];
  assert.ok(value, "src が無い");
  return new URL(value.replace(/&amp;/g, "&"));
}

function renderPlayers(
  cards: ToolCard[],
  { rootCwd = "/work", cwd = "projects/u7agent" }: { rootCwd?: string; cwd?: string } = {},
): string {
  return renderToStaticMarkup(createElement(SpeechPlayerList, { cards, rootCwd, cwd, rawUrl, compact: false }));
}

function renderMessage(bubble: Bubble, overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(MessageView, {
      bubble,
      skillBadges: [],
      copied: false,
      compact: false,
      rootCwd: "/work",
      cwd: "projects/u7agent",
      rawUrl,
      onCopy: () => {},
      copiedId: "",
      copyFailure: () => undefined,
      onCopyTool: () => {},
      copiedAll: false,
      onCopyAll: () => {},
      ...overrides,
    }),
  );
}

test("生成音声は raw URL の <audio controls> で再生し、cwd 相対を root 相対へ解決する", () => {
  const html = renderPlayers([card()]);
  const [tag] = audioTags(html);
  assert.ok(tag, "audio 要素が無い");
  assert.ok(tag.includes("controls"), "controls が無い");
  assert.ok(
    tag.includes('aria-label="projects/u7agent/generated/intro.mp3 のプレビュー"'),
    "解決後のパスで操作名を出していない",
  );
  const src = audioSrc(tag);
  assert.equal(src.pathname, "/api/files/raw");
  assert.equal(src.searchParams.get("path"), "projects/u7agent/generated/intro.mp3", "解決したパスが違う");
  assert.equal(src.searchParams.get("v"), String(VERSION), "版が付いていない");
});

test("rootCwd 前置きの絶対パスは cwd 相対へ畳んでから解決する", () => {
  const output = SPEECH_OUTPUT.replace(
    "音声を生成して保存しました: generated/intro.mp3",
    "音声を生成して保存しました: /work/projects/u7agent/generated/intro.mp3",
  );
  const src = audioSrc(audioTags(renderPlayers([card({ output })]))[0]);
  assert.equal(src.searchParams.get("path"), "projects/u7agent/generated/intro.mp3");
});

test("同じターンの複数音声は生成した数だけ順に出し、形式はどちらも配信する", () => {
  const wav = SPEECH_OUTPUT.replace(/generated\/intro\.mp3/g, "generated/intro.wav");
  const html = renderPlayers([card({ id: "t1" }), card({ id: "t2", output: wav })]);
  assert.deepEqual(
    audioTags(html).map((tag) => audioSrc(tag).searchParams.get("path")),
    ["projects/u7agent/generated/intro.mp3", "projects/u7agent/generated/intro.wav"],
  );
});

test("cwd や rootCwd が未取得なら解決できずに出さない", () => {
  assert.equal(renderPlayers([card()], { cwd: "" }), "", "cwd 未取得で出している");
  // cwd 相対のパスは rootCwd が無くても解決できる (Markdown 画像と同じ)
  assert.equal(audioTags(renderPlayers([card()], { rootCwd: "" })).length, 1);
  const absolute = SPEECH_OUTPUT.replace(
    "音声を生成して保存しました: generated/intro.mp3",
    "音声を生成して保存しました: /work/projects/u7agent/generated/intro.mp3",
  );
  assert.equal(
    renderPlayers([card({ output: absolute })], { rootCwd: "" }),
    "",
    "rootCwd 未取得で絶対パスを解決している",
  );
});

test("生成音声以外とパスが読めないカードでは出さない", () => {
  assert.equal(renderPlayers([]), "");
  assert.equal(renderPlayers([card({ name: "generate_image", output: IMAGE_OUTPUT })]), "", "画像に出している");
  assert.equal(renderPlayers([card({ name: "bash", output: SPEECH_OUTPUT })]), "", "生成以外のツールに出している");
  assert.equal(
    renderPlayers([card({ output: "モデル: google/gemini-3.8-flash-tts\nこの行が続きます" })]),
    "",
    "パスが読めないカードに出している",
  );
  assert.equal(
    renderPlayers([card({ phase: "failed", output: "音声生成が混雑しています（レート制限またはプロバイダー障害）" })]),
    "",
    "失敗したカードに出している",
  );
});

test("描画: MessageView は本文の直後（メタ行の前）にプレイヤーを出す", () => {
  const bubble: Bubble = {
    id: 1,
    role: "assistant",
    text: "読み上げたのだ",
    at: Date.parse("2026-01-01T00:00:00Z"),
    tools: [card()],
    skillLoads: [],
  };
  const html = renderMessage(bubble);
  const audioAt = html.indexOf("<audio");
  assert.ok(audioAt > 0, "audio が出ていない");
  assert.ok(html.indexOf("読み上げたのだ") < audioAt, "本文より前に出ている");
  assert.ok(audioAt < html.indexOf("<time"), "メタ行より後ろに出ている");

  const image = renderMessage({ ...bubble, tools: [card({ name: "generate_image", output: IMAGE_OUTPUT })] });
  assert.equal(image.includes("<audio"), false, "画像のターンに出している");
  assert.equal(renderMessage(bubble, { cwd: "" }).includes("<audio"), false, "cwd 未取得で出している");
  assert.equal(
    renderMessage(bubble, { rawUrl: undefined }).includes("<audio"),
    false,
    "解決用の props 無しで出している",
  );
});
