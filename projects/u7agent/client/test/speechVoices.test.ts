// ボイスの表示属性とグループ分け。並び・ラベル・未知の声の扱いを純関数で固定する
// (どのように描画するかは contentSettingsTab / speechPlayground の SSR テストが見る)。

import assert from "node:assert/strict";
import test from "node:test";
import { speechVoiceGroups, speechVoiceTag } from "../src/lib/speechVoices";

test("google のモデルは女性 → 男性 → 名前順に並べ、未知の声は末尾のグループ無しへ回す", () => {
  const groups = speechVoiceGroups("google/gemini-3.8-flash-tts", [
    "Puck", // 男性
    "Zephyr", // 女性
    "Ghost", // 未知
    "Kore", // 女性
    "Charon", // 男性
  ]);

  assert.deepEqual(
    groups.map((group) => group.label),
    ["女性", "男性", null],
    "性別のグループを先に、引けない声を最後に出す",
  );
  assert.deepEqual(
    groups[0].options,
    [
      { value: "Kore", label: "Kore（Firm）" },
      { value: "Zephyr", label: "Zephyr（Bright）" },
    ],
    "女性は名前の昇順で、1 語のスタイル語を添える",
  );
  assert.deepEqual(
    groups[1].options,
    [
      { value: "Charon", label: "Charon（Informative）" },
      { value: "Puck", label: "Puck（Upbeat）" },
    ],
    "男性も名前の昇順にする",
  );
  assert.deepEqual(groups[2].options, [{ value: "Ghost", label: "Ghost" }], "引けない声は名前だけのラベルにする");
});

test("宣言のある他プロバイダは、入力順のまま 1 グループで返して選択肢を消さない", () => {
  const voices = ["flux-bruce-en", "flux-luna-en", "flux-asteria-en"];
  assert.deepEqual(speechVoiceGroups("deepgram/flux-tts", voices), [
    { label: null, options: voices.map((voice) => ({ value: voice, label: voice })) },
  ]);
});

test("google 以外のモデルでは属性を引かない", () => {
  assert.deepEqual(
    speechVoiceGroups("elevenlabs/eleven-v4", ["Kore", "Zephyr"]),
    [
      {
        label: null,
        options: [
          { value: "Kore", label: "Kore" },
          { value: "Zephyr", label: "Zephyr" },
        ],
      },
    ],
    "同名でも他プロバイダのボイスへ性別やスタイル語を付けない",
  );
  assert.equal(speechVoiceTag("Kore")?.style, "Firm", "引く条件はグループ化だけが持ち、名前自体は引ける");
});

test("google のモデルでも属性を引ける声が無ければ 1 グループのままにする", () => {
  assert.deepEqual(speechVoiceGroups("google/gemini-3.8-flash-tts", ["Ghost", "Phantom"]), [
    {
      label: null,
      options: [
        { value: "Ghost", label: "Ghost" },
        { value: "Phantom", label: "Phantom" },
      ],
    },
  ]);
});

test("Object.prototype の名前は属性として引かず、未知の声として扱う", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(speechVoiceTag(name), undefined, `${name} を属性として返さない`);
  }
  assert.deepEqual(
    speechVoiceGroups("google/test", ["constructor", "Kore"]),
    [
      { label: "女性", options: [{ value: "Kore", label: "Kore（Firm）" }] },
      { label: null, options: [{ value: "constructor", label: "constructor" }] },
    ],
    "継承プロパティをタグありと扱わず、未知の声として末尾へ回す",
  );
  assert.deepEqual(
    speechVoiceGroups("google/test", ["__proto__", "toString"]),
    [
      {
        label: null,
        options: [
          { value: "__proto__", label: "__proto__" },
          { value: "toString", label: "toString" },
        ],
      },
    ],
    "境界名だけの宣言もグループ無しの 1 つとして返す",
  );
});

test("宣言に片方の性別しか無いときは空のグループを返さない", () => {
  assert.deepEqual(
    speechVoiceGroups("google/gemini-3.8-flash-tts", ["Kore", "Leda"]).map((group) => group.label),
    ["女性"],
  );
  assert.deepEqual(
    speechVoiceGroups("google/gemini-3.8-flash-tts", ["Puck"]).map((group) => group.label),
    ["男性"],
  );
});

test("宣言が無い / 空のときは空配列", () => {
  assert.deepEqual(speechVoiceGroups("google/gemini-3.8-flash-tts", undefined), []);
  assert.deepEqual(speechVoiceGroups("google/gemini-3.8-flash-tts", []), []);
});

/** OpenRouter が宣言する Google の 30 件。server の同梱カタログと同じ顔ぶれをここでも固定する */
const GOOGLE_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];

test("Google の 30 件はすべて属性を引き、女性 14 / 男性 16 になる", () => {
  const tags = GOOGLE_VOICES.map((voice) => speechVoiceTag(voice));
  assert.equal(tags.filter((tag) => tag === undefined).length, 0, "写しの欠けと綴り間違いをここで止める");
  assert.equal(tags.filter((tag) => tag?.gender === "female").length, 14);
  assert.equal(tags.filter((tag) => tag?.gender === "male").length, 16);

  const groups = speechVoiceGroups("google/gemini-3.8-flash-tts", GOOGLE_VOICES);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["女性", "男性"],
    "30 件すべてに属性があるので、グループ無しは出ない",
  );
  for (const group of groups) {
    const names = group.options.map((option) => option.value);
    assert.deepEqual(names, [...names].sort(), "グループの中は名前の昇順にする");
    for (const option of group.options) {
      assert.match(option.label, /^[A-Za-z]+（[A-Za-z-]+）$/, `${option.value} は 名前（スタイル語） の形で出す`);
      assert.ok(GOOGLE_VOICES.includes(option.value), "選択肢の value は上流へ送る綴りのままにする");
    }
  }
});
