// provider ロゴの対応表と描画。SDK の builtin provider id は lib/providerIcon の表でロゴへ寄せ、
// 表に無い provider（カスタム / SDK の新顔）は頭文字のタイルへ落とす。

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderIcon } from "../src/components/ProviderIcon";
import { providerIconKey, providerMonogram } from "../src/lib/providerIcon";

test("builtin provider はロゴへ寄せ、派生 provider も同じロゴを使う", () => {
  assert.equal(providerIconKey("deepseek"), "deepseek");
  assert.equal(providerIconKey("amazon-bedrock"), "bedrock");
  assert.equal(providerIconKey("google"), "gemini");
  assert.equal(providerIconKey("openai-codex"), "openai");
  assert.equal(providerIconKey("zai-coding-cn"), "zai");
  assert.equal(providerIconKey("xiaomi-token-plan-sgp"), "xiaomimimo");
});

test("ロゴの無い provider は null（呼び出し側は頭文字へ落とす）", () => {
  assert.equal(providerIconKey("radius"), null);
  assert.equal(providerIconKey("my-custom-provider"), null);
});

test("頭文字は名前の語頭を 2 つまで取り、名前が空なら id を使う", () => {
  assert.equal(providerMonogram("Amazon Bedrock", "amazon-bedrock"), "AB");
  assert.equal(providerMonogram("Faux", "faux"), "F");
  assert.equal(providerMonogram("", "my-provider"), "MP");
  assert.equal(providerMonogram("日本語", "ja"), "日");
});

test("ロゴがある provider は svg を描き、無い provider は頭文字を出す", () => {
  const known = renderToStaticMarkup(createElement(ProviderIcon, { provider: "openai", name: "OpenAI" }));
  assert.ok(known.includes('aria-hidden="true"'), "ロゴは装飾として隠す");
  assert.ok(known.includes("<svg"), "ロゴは svg で描く");
  assert.equal(known.includes(">O<"), false, "頭文字は出さない");

  const unknown = renderToStaticMarkup(createElement(ProviderIcon, { provider: "radius", name: "Radius" }));
  assert.equal(unknown.includes("<svg"), false, "ロゴが無ければ svg を描かない");
  assert.ok(unknown.includes(">R<"), "ロゴが無ければ頭文字を出す");
});
