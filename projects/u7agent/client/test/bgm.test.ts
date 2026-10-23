import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { chatReducer, initialChatState } from "../src/hooks/chatReducer";
import { historyItemsToBundle } from "../src/lib/chatHistory";
import { estimateChatItemHeight } from "../src/lib/chatItems";
import type { Bubble, ToolCard } from "../src/lib/chatTypes";
import { generationCaptionsOf, generationInfoOf } from "../src/lib/generationInfo";
import { GenerationBadgeList } from "../src/components/chat/GenerationBadgeList";
import { SpeechPlayerList } from "../src/components/chat/SpeechPlayerList";
import { parseRoute, routePath } from "../src/lib/route";

const model = "google/lyria-3-clip-preview";
const output = `モデル: ${model}\nBGMを生成して保存しました: output/racing-1.mp3\n形式: MP3\n本文には、この実保存パスを示してください。`;
const card = (overrides: Partial<ToolCard> = {}): ToolCard => ({
  id: "b1",
  name: "generate_bgm",
  args: "{}",
  phase: "done",
  output,
  ...overrides,
});

test("BGM結果の先頭2行からモデル・実保存先を読み、TTSボイスを拾わない", () => {
  assert.deepEqual(generationInfoOf(card({ output: output + "\nボイス: invented\n" })), {
    kind: "bgm",
    model,
    path: "output/racing-1.mp3",
  });
  assert.equal(generationInfoOf(card({ phase: "failed" })), undefined);
  assert.equal(generationInfoOf(card({ output: "BGMを生成して保存しました: output/racing-1.mp3\n" })), undefined);
  const route = parseRoute("/settings/content/bgm");
  assert.equal(routePath(route), "/settings/content/bgm");
});

test("ライブと履歴復元はBGM2本とTTSのカード・caption・版付きaudioを同じ順に表示する", () => {
  const cards = [
    card(),
    card({ id: "b2", output: output.replace("racing-1", "racing-2") }),
    card({
      id: "s1",
      name: "generate_speech",
      output: "モデル: tts-model\nボイス: Kore\n音声を生成して保存しました: output/intro.wav\n",
    }),
  ];
  let live = initialChatState;
  for (const card of cards) {
    live = chatReducer(live, { type: "toolStart", id: card.id, name: card.name, args: card.args, at: 100 });
    live = chatReducer(live, { type: "toolEnd", id: card.id, isError: false, output: card.output });
  }
  const restored = historyItemsToBundle(1, [
    {
      kind: "message",
      id: "history1",
      context: "active",
      role: "assistant",
      text: "できました",
      tools: cards.map((card) => ({
        id: card.id,
        name: card.name,
        args: card.args,
        output: card.output,
        done: true,
        isError: false,
      })),
    },
  ]);
  const liveCards = live.bubbles.flatMap((bubble) => bubble.tools);
  assert.deepEqual(liveCards.map(generationInfoOf), restored.bubbles[0].tools.map(generationInfoOf));
  const render = (cards: ToolCard[], singleColumn: boolean) => {
    const bubbles: Bubble[] = [{ id: 1, role: "assistant", text: "", tools: cards, skillLoads: [] }];
    const captions = generationCaptionsOf(bubbles, { rootCwd: "/work", cwd: ".u7agent/sessions/test" }).get(1);
    return renderToStaticMarkup(
      createElement(SpeechPlayerList, {
        cards,
        rootCwd: "/work",
        cwd: ".u7agent/sessions/test",
        singleColumn,
        captions,
        rawUrl: (path) => `https://app.test/api/files/raw?path=${encodeURIComponent(path)}&v=42`,
      }),
    );
  };
  for (const singleColumn of [false, true]) {
    const html = render(liveCards, singleColumn);
    assert.equal(html, render(restored.bubbles[0].tools, singleColumn));
    const audio = [...html.matchAll(/<audio\b[^>]*>/g)].map((match) => match[0]);
    assert.equal(audio.length, 3);
    audio.forEach((tag) => {
      assert.match(tag, /controls/);
      assert.doesNotMatch(tag, /autoplay/i);
      assert.match(tag, /v=42/);
      assert.doesNotMatch(tag, /onplay|onseek/i);
    });
    assert.match(audio[0], /racing-1.mp3/);
    assert.match(audio[1], /racing-2.mp3/);
    assert.match(audio[2], /intro.wav/);
    assert.equal((html.match(/ボイス/g) ?? []).length, 2, "TTSの表示とtitleだけ");
    assert.equal((html.match(new RegExp(model, "g")) ?? []).length, 4, "BGMの表示とtitleが2本分");
  }
  const badges = renderToStaticMarkup(createElement(GenerationBadgeList, { cards, singleColumn: false }));
  assert.equal((badges.match(/>BGM</g) ?? []).length, 2);
});

test("失敗BGMにプレイヤーを出さず、成功BGMには高さ見積りを加算する", () => {
  const failed = card({ phase: "failed" });
  assert.equal(
    renderToStaticMarkup(
      createElement(SpeechPlayerList, {
        cards: [failed],
        rootCwd: "/work",
        cwd: "project",
        rawUrl: () => "unexpected",
        singleColumn: false,
      }),
    ),
    "",
  );
  const height = (tool: ToolCard) =>
    estimateChatItemHeight({
      kind: "message",
      key: "m1",
      bubble: { id: 1, role: "assistant", text: "", tools: [tool], skillLoads: [] },
    });
  assert.ok(height(card()) > height(card({ name: "bash" })));
});
