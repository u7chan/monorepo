// fixture のキーワード選択の検証。完全一致 → 最長の部分一致 → prompt 省略の順で選び、配列の並びに依存しない。
import assert from "node:assert/strict";
import test from "node:test";
import { stubAskUserOf, stubInvestigateOf, stubLiveThinkingOf, stubToolBurstOf } from "./stub-pi";

/** fixture (spaces-fixture.ts) が持つキーワード。並びも同じにして選択の回帰を見る */
const KEYWORDS = [
  "画像バッジ",
  "画像バッジ本文なし",
  "音声バッジ",
  "モデル行なし",
  "生成失敗",
  "複数モデル",
  "音声2本",
  "音声モデル行なし",
  "音声失敗",
  "画像再掲",
];

test("送信本文に合う burst は完全一致を優先し、次に長い部分一致を採る", () => {
  const bursts = KEYWORDS.map((prompt) => ({ prompt }));
  for (const keyword of KEYWORDS) {
    assert.equal(stubToolBurstOf(bursts, keyword)?.prompt, keyword, `${keyword} で別の burst が選ばれている`);
    assert.equal(
      stubToolBurstOf(bursts, `${keyword} を送ります`)?.prompt,
      keyword,
      `${keyword} の部分一致が短いキーワードに食われている`,
    );
  }
  // キーワードが部分文字列の関係にあるときも、配列の並びで選択が変わらない
  const conflict = [{ prompt: "音声モデル行なし" }, { prompt: "モデル行なし" }];
  assert.equal(stubToolBurstOf(conflict, "音声モデル行なし")?.prompt, "音声モデル行なし");
  assert.equal(stubToolBurstOf([...conflict].reverse(), "音声モデル行なし")?.prompt, "音声モデル行なし");
  assert.equal(stubToolBurstOf(conflict, "モデル行なし")?.prompt, "モデル行なし");
});

test("一致が無ければ prompt 省略の burst へ落ち、それも無ければ何も選ばない", () => {
  const catchAll = { calls: [] };
  assert.equal(stubToolBurstOf([catchAll], "どれでもない"), catchAll);
  assert.equal(
    stubToolBurstOf([catchAll, { prompt: "画像バッジ" }], "画像バッジ")?.prompt,
    "画像バッジ",
    "明示の一致が prompt 省略の burst に負けている",
  );
  assert.equal(stubToolBurstOf([{ prompt: "画像バッジ" }], "どれでもない"), undefined);
  assert.equal(stubToolBurstOf(undefined, "画像バッジ"), undefined);
  assert.equal(stubToolBurstOf({ prompt: "画像バッジ" }, "画像バッジ")?.prompt, "画像バッジ", "1 件だけの指定");
});

// What: thinking / ask_user / investigate の合成シナリオは、それぞれの依頼文でだけ選ばれる。
// 選ばれないシナリオが先頭で phase を奪うと、受入の phase 列が変わる (fixture の再現性)。
test("thinking / ask_user / investigate のシナリオは依頼文で選び分ける", () => {
  const thinking = [
    { prompt: "長い思考", chunks: ["a"] },
    { prompt: "思考の再開", chunks: ["b"], resumeChunks: ["c"] },
    { prompt: "質問して", chunks: ["d"] },
  ];
  assert.equal(stubLiveThinkingOf(thinking, "長い思考を見せて")?.prompt, "長い思考");
  assert.equal(stubLiveThinkingOf(thinking, "思考の再開を見せて")?.prompt, "思考の再開");
  assert.equal(stubLiveThinkingOf(thinking, "質問して")?.prompt, "質問して");
  assert.equal(stubLiveThinkingOf(thinking, "こんにちは"), undefined);
  // 文字列が伸びても短いキーワードに食われない
  assert.equal(stubLiveThinkingOf(thinking, "長い思考と思考の再開を見せて")?.prompt, "思考の再開");

  const askTurn = { prompt: "質問して", questions: [] };
  assert.equal(stubAskUserOf(askTurn, "質問して")?.prompt, "質問して");
  assert.equal(stubAskUserOf(askTurn, "長い思考を見せて"), undefined);

  const investigate = { prompt: "docs を調べ", trigger: "調べて", progress: ["p"] };
  assert.equal(stubInvestigateOf(investigate, "調べて")?.trigger, "調べて");
  assert.equal(stubInvestigateOf(investigate, "長い思考を見せて"), undefined, "trigger が無い依頼文では流さない");
  // trigger を省いた既存のシナリオは毎ターン流す
  assert.equal(stubInvestigateOf({ prompt: "docs を調べ" }, "何でも")?.prompt, "docs を調べ");
});
