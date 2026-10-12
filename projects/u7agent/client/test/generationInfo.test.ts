// 生成ツール（generate_image / generate_speech）の結果本文からバッジの材料（モデル / ボイス / 保存パス）を
// 読む純関数の検証。結果本文の形の正は server/src/image-tools.ts / server/src/speech-tools.ts。
import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCard } from "../src/lib/chatTypes";
import { generationBadgesOf, generationInfoOf } from "../src/lib/generationInfo";

const IMAGE_OUTPUT =
  "モデル: openai/gpt-image-2\n" +
  "画像を生成して保存しました: generated/night-platform-cat.png\n" +
  "本文に示すときは Markdown 画像 ![alt](generated/night-platform-cat.png) で示してください。";

const SPEECH_OUTPUT =
  "モデル: google/gemini-3.8-flash-tts\n" +
  "ボイス: Kore\n" +
  "音声を生成して保存しました: generated/night-platform-cat-intro.mp3\n" +
  "本文に示すときは、このパス (generated/night-platform-cat-intro.mp3) を示してください。";

function card(overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: "call-1", name: "generate_image", args: "{}", phase: "done", output: IMAGE_OUTPUT, ...overrides };
}

/** server の toolResultSummary と同じ投影（先頭 900 文字 + …）で切る */
function projected(text: string): string {
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
}

test("画像の結果からはモデルと保存パスだけを読む", () => {
  assert.deepEqual(generationInfoOf(card()), {
    kind: "image",
    model: "openai/gpt-image-2",
    path: "generated/night-platform-cat.png",
  });
});

test("音声の結果からはモデル・ボイス・保存パスを読む", () => {
  assert.deepEqual(generationInfoOf(card({ name: "generate_speech", output: SPEECH_OUTPUT })), {
    kind: "speech",
    model: "google/gemini-3.8-flash-tts",
    voice: "Kore",
    path: "generated/night-platform-cat-intro.mp3",
  });
});

test("ボイスの指定が無い実行では結果本文の文言をそのまま返す", () => {
  const output = SPEECH_OUTPUT.replace("ボイス: Kore", "ボイス: （モデル既定）");
  assert.equal(generationInfoOf(card({ name: "generate_speech", output }))?.voice, "（モデル既定）");
});

test("モデル行が無い結果（モデル行を書く前のセッション）では何も出さない", () => {
  const output = "画像を生成して保存しました: generated/legacy.png\n本文に示すときは Markdown 画像で示してください。";
  assert.equal(generationInfoOf(card({ output })), undefined);
  assert.equal(generationInfoOf(card({ name: "generate_speech", output })), undefined);
});

test("保存パスが取れない結果ではモデルだけを返す", () => {
  assert.deepEqual(generationInfoOf(card({ output: "モデル: openai/gpt-image-2\nこの行が続きます" })), {
    kind: "image",
    model: "openai/gpt-image-2",
  });
  assert.deepEqual(
    generationInfoOf(
      card({ name: "generate_speech", output: "モデル: google/gemini-3.8-flash-tts\nこの行が続きます" }),
    ),
    { kind: "speech", model: "google/gemini-3.8-flash-tts" },
  );
});

test("投影で切れた保存パスは実パスとして返さない", () => {
  // 180 文字のディレクトリを 5 段連ねた有効な path (server/test/image-tools.test.ts と同じ形)
  const longPath = `generated/${Array.from({ length: 5 }, () => "d".repeat(180)).join("/")}/cafe.png`;
  const body =
    `モデル: openai/gpt-image-2\n画像を生成して保存しました: ${longPath}\n` +
    "本文に示すときは Markdown 画像で示してください。";
  const cut = projected(body);
  assert.ok(cut.endsWith("…"), "投影で途中までになっている");
  const info = generationInfoOf(card({ output: cut }));
  assert.equal(info?.model, "openai/gpt-image-2", "先頭のモデル行は切詰めても残る");
  assert.equal(info?.path, undefined, "ファイル名を失った断片を実パスとして返さない");

  // 投影で切れていない本文（パス行が改行で終わっている）では保存パスを返す
  const shortPath = `generated/${"d".repeat(180)}/cafe.png`;
  const complete =
    `モデル: openai/gpt-image-2\n画像を生成して保存しました: ${shortPath}\n` +
    "本文に示すときは Markdown 画像で示してください。";
  assert.equal(complete.length < 900, true, "投影の上限に収まる本文");
  assert.equal(generationInfoOf(card({ output: complete }))?.path, shortPath);
});

test("対象外のツールと失敗したカードでは何も出さない", () => {
  // 結果本文に同じ文言が入っていても、対象ツールでなければバッジにしない
  assert.equal(generationInfoOf(card({ name: "bash", output: IMAGE_OUTPUT })), undefined);
  assert.equal(generationInfoOf(card({ name: "generate_image", phase: "failed" })), undefined);
  assert.equal(generationInfoOf(card({ name: "generate_image", phase: "running", output: "" })), undefined);
});

test("長い本文でも先頭の数行だけを見る（投影の切詰めでモデル行と保存パスが残る）", () => {
  const long = `${IMAGE_OUTPUT}\n${"本文の続きです。".repeat(400)}`;
  assert.ok(long.length > 900, "投影の上限を超える本文");
  assert.deepEqual(generationInfoOf(card({ output: projected(long) })), {
    kind: "image",
    model: "openai/gpt-image-2",
    path: "generated/night-platform-cat.png",
  });
  // 先頭の数行より後ろにしか無い行は読まない（本文中の無関係な文言を拾わない）
  assert.equal(generationInfoOf(card({ output: `結果です。\n\n\nモデル: openai/gpt-image-2` })), undefined);
});

test("改行で終わっていない最終行は値として読まない", () => {
  // 完全な結果本文ではモデル行の後ろにも行が続く。単独行の結果は投影で切れた断片と区別できない
  assert.equal(generationInfoOf(card({ output: "モデル: openai/gpt-image-2" })), undefined);
  assert.equal(generationInfoOf(card({ output: "モデル: openai/gpt-image-2\n" }))?.model, "openai/gpt-image-2");
});

test("バッジはカードの順のまま生成ツールの分だけを返す", () => {
  const cards = [
    card({ id: "t1" }),
    card({ id: "t2", name: "bash", output: "ok" }),
    card({ id: "t3", name: "generate_speech", output: SPEECH_OUTPUT }),
    card({ id: "t4", name: "generate_image", phase: "failed", output: "画像生成が混雑しています" }),
  ];
  assert.deepEqual(
    generationBadgesOf(cards).map((badge) => [badge.key, badge.info.kind, badge.info.model]),
    [
      ["t1", "image", "openai/gpt-image-2"],
      ["t3", "speech", "google/gemini-3.8-flash-tts"],
    ],
  );
});
