// 生成物のキャプション（段落の中の画像の直下と、音声プレイヤーの直下）の検証。DOM 基盤が無いため
// react-dom/server の静的描画で固定する（画像の前例 client/test/markdownImage.test.ts）。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Bubble, ToolCard } from "../src/lib/chatTypes";
import { generationCaptionsOf, type GenerationInfo } from "../src/lib/generationInfo";

// MessageView は AttachedFiles 経由で api.ts (location.origin を読む) を辿るため、先に shim を置く
globalThis.location ??= { origin: "http://localhost:3000", hostname: "localhost" } as Location;
const { MarkdownCaptionProvider, MarkdownFileImageProvider, MarkdownImageProvider, useMarkdownImageSrc } =
  await import("../src/components/markdown/MarkdownImageRefs");
const { MarkdownView } = await import("../src/components/markdown/MarkdownView");
const { MessageView } = await import("../src/components/chat/MessageView");

const ROOT_CWD = "/workspace";
const CWD = "projects/u7agent";
const rawUrl = (path: string): string => `/api/files/raw?path=${path}`;

const IMAGE_OUTPUT =
  "モデル: openai/gpt-image-2\n画像を生成して保存しました: generated/cafe.png\n" +
  "本文に示すときは Markdown 画像で示してください。";

const SPEECH_OUTPUT =
  "モデル: google/gemini-3.8-flash-tts\nボイス: Kore\n" +
  "音声を生成して保存しました: generated/intro.mp3\n" +
  "本文に示すときは、このパス (generated/intro.mp3) を示してください。";

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "generate_image", args: "{}", phase: "done", output: IMAGE_OUTPUT, ...overrides };
}

/** 1 バブルの生成カードから、そのターンの対応表を作る */
function captionsOf(cards: ToolCard[]): Map<string, GenerationInfo> {
  const bubbles: Bubble[] = [{ id: 1, role: "assistant", text: "", tools: cards, skillLoads: [] }];
  return generationCaptionsOf(bubbles, { rootCwd: ROOT_CWD, cwd: CWD }).get(1) ?? new Map();
}

function renderBody(text: string, captions?: Map<string, GenerationInfo>): string {
  return renderToStaticMarkup(
    createElement(MarkdownImageProvider, {
      rootCwd: ROOT_CWD,
      cwd: CWD,
      rawUrl,
      children: createElement(MarkdownCaptionProvider, {
        captions,
        children: createElement(MarkdownView, { text }),
      }),
    }),
  );
}

function renderMessage(bubble: Bubble, overrides: Record<string, unknown> = {}): string {
  // App は MarkdownImageProvider で ChatArea ごと包む (画像の src 解決は MessageView の外から来る)
  return renderToStaticMarkup(
    createElement(MarkdownImageProvider, {
      rootCwd: ROOT_CWD,
      cwd: CWD,
      rawUrl,
      children: createElement(MessageView, {
        bubble,
        skillBadges: [],
        copied: false,
        compact: false,
        rootCwd: ROOT_CWD,
        cwd: CWD,
        rawUrl,
        onCopy: () => {},
        copiedId: "",
        copyFailure: () => undefined,
        onCopyTool: () => {},
        copiedAll: false,
        onCopyAll: () => {},
        ...overrides,
      }),
    }),
  );
}

test("描画: 段落の中の画像の直後にキャプションが出る", () => {
  const html = renderBody("![cafe](generated/cafe.png)", captionsOf([card()]));
  assert.ok(html.includes('src="/api/files/raw?path=projects/u7agent/generated/cafe.png"'), html);
  assert.ok(html.includes('<span class="block">'), "画像とキャプションを包む block の span が無い");
  assert.ok(html.includes(">openai/gpt-image-2<"), "モデルが出ていない");
  assert.ok(html.includes(">generated/cafe.png<"), "保存パスが出ていない");
  assert.ok(html.includes('title="openai/gpt-image-2"'), "省略時の全文が無い");
  assert.ok(html.indexOf("</button>") < html.indexOf("openai/gpt-image-2"), "画像より前に出ている");
  assert.ok(html.indexOf("openai/gpt-image-2") < html.indexOf("</p>"), "段落の外に出ている");
  assert.equal(html.includes("ボイス"), false, "画像にボイスを出している");
});

test("描画: 見出し・表のセル・引用ではキャプションを出さない", () => {
  const captions = captionsOf([card()]);
  const texts = [
    "## ![cafe](generated/cafe.png)",
    // 強調の中の画像も印を落とさない
    "## **![cafe](generated/cafe.png)**",
    "| a |\n| --- |\n| ![cafe](generated/cafe.png) |",
    "> ![cafe](generated/cafe.png)",
    "> **![cafe](generated/cafe.png)**",
  ];
  for (const text of texts) {
    const html = renderBody(text, captions);
    assert.ok(html.includes("/api/files/raw?path=projects/u7agent/generated/cafe.png"), `画像が出ていない: ${text}`);
    assert.equal(html.includes("openai/gpt-image-2"), false, `キャプションが出ている: ${text}`);
  }
});

test("描画: 対応が無い画像では出さない", () => {
  const other = captionsOf([card({ output: IMAGE_OUTPUT.replace("cafe.png", "other.png") })]);
  assert.equal(renderBody("![cafe](generated/cafe.png)", other).includes("openai/gpt-image-2"), false);
  assert.equal(
    renderBody("![cafe](generated/cafe.png)").includes("openai/gpt-image-2"),
    false,
    "provider 無しで出ている",
  );
  assert.equal(
    renderBody("![cafe](https://example.test/cafe.png)", captionsOf([card()])).includes("openai/gpt-image-2"),
    false,
    "外部 URL に出している",
  );
  // 表記ゆれ (`./` 付き) と行内の画像でも同じキーで引ける
  assert.ok(renderBody("![cafe](./generated/cafe.png)", captionsOf([card()])).includes("openai/gpt-image-2"));
  assert.ok(renderBody("前 ![cafe](generated/cafe.png) 後", captionsOf([card()])).includes("openai/gpt-image-2"));
  assert.ok(renderBody("**![cafe](generated/cafe.png)**", captionsOf([card()])).includes("openai/gpt-image-2"));
  // リンクのラベルの画像は描画自体が素の字面になる (キャプションも出ない)
  const link = renderBody("[![cafe](generated/cafe.png)](https://example.test/)", captionsOf([card()]));
  assert.equal(link.includes("openai/gpt-image-2"), false);
});

test("描画: ファイルプレビューの Markdown では出さない", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownFileImageProvider, {
      dir: ".",
      rawUrl,
      children: createElement(MarkdownView, { text: "![cafe](generated/cafe.png)" }),
    }),
  );
  assert.ok(html.includes('src="/api/files/raw?path=generated/cafe.png"'), html);
  assert.equal(html.includes("openai/gpt-image-2"), false, "プレビューにキャプションが出ている");
});

/** `useMarkdownImageSrc` の既存契約 (provider の外と解決できない src は入力をそのまま返す) を直接見る */
function SrcProbe({ src }: { src: string }) {
  return createElement("span", { "data-src": useMarkdownImageSrc(src) });
}

test("解決 URL だけを返す既存の契約は変わらない", () => {
  const probe = (src: string, provider: boolean): string => {
    const element = createElement(SrcProbe, { src });
    return renderToStaticMarkup(
      provider
        ? createElement(MarkdownImageProvider, { rootCwd: ROOT_CWD, cwd: CWD, rawUrl, children: element })
        : element,
    );
  };
  assert.equal(
    probe("generated/cafe.png", true),
    '<span data-src="/api/files/raw?path=projects/u7agent/generated/cafe.png"></span>',
  );
  assert.equal(probe("generated/cafe.png", false), '<span data-src="generated/cafe.png"></span>');
  assert.equal(probe("https://example.test/cafe.png", true), '<span data-src="https://example.test/cafe.png"></span>');
});

test("描画: MessageView は本文の画像にキャプションを出し、未指定なら出さない", () => {
  const bubble: Bubble = {
    id: 1,
    role: "assistant",
    text: "![cafe](generated/cafe.png)",
    tools: [card()],
    skillLoads: [],
  };
  const captions = generationCaptionsOf([bubble], { rootCwd: ROOT_CWD, cwd: CWD }).get(1);
  // モデル id は本文の上のバッジにも出るため、キャプションの印 (block の wrapper) で見分ける
  assert.ok(renderMessage(bubble, { captions }).includes('<span class="block">'), "キャプションが出ていない");
  assert.equal(renderMessage(bubble).includes('<span class="block">'), false, "captions 未指定で出している");
});

test("描画: 音声プレイヤーの直下にもボイスつきでキャプションが出る", () => {
  const bubble: Bubble = {
    id: 1,
    role: "assistant",
    text: "",
    tools: [card({ name: "generate_speech", output: SPEECH_OUTPUT })],
    skillLoads: [],
  };
  const captions = generationCaptionsOf([bubble], { rootCwd: ROOT_CWD, cwd: CWD }).get(1);
  const html = renderMessage(bubble, { captions });
  assert.ok(html.includes("</audio>"), "プレイヤーが出ていない");
  // モデルは本文の上のバッジにも出るため、プレイヤーより後ろだけを見る
  const afterPlayer = html.slice(html.indexOf("</audio>"));
  assert.ok(afterPlayer.includes(">google/gemini-3.8-flash-tts<"), "モデルが出ていない");
  assert.ok(afterPlayer.includes("ボイス Kore"), "ボイスが出ていない");
  assert.ok(afterPlayer.includes(">generated/intro.mp3<"), "保存パスが出ていない");
  const withoutCaptions = renderMessage(bubble);
  assert.equal(
    withoutCaptions.slice(withoutCaptions.indexOf("</audio>")).includes("google/gemini-3.8-flash-tts"),
    false,
    "captions 未指定で出している",
  );
});
