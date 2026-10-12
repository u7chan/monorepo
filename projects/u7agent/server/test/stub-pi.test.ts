// fixture のキーワード選択の検証。完全一致 → 最長の部分一致 → prompt 省略の順で選び、配列の並びに依存しない。
import assert from "node:assert/strict";
import test from "node:test";
import { stubToolBurstOf } from "./stub-pi";

/** fixture (spaces-fixture.ts) が持つキーワード。並びも同じにして選択の回帰を見る */
const KEYWORDS = [
  "画像バッジ",
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
