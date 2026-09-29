// provider ロゴの対応表と描画。SDK の builtin provider id は lib/providerIcon の表でロゴへ寄せ、
// 表に無い provider（カスタム / SDK の新顔）は頭文字のタイルへ落とす。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderIcon } from "../src/components/ProviderIcon";
import { providerIconKey, providerMonogram } from "../src/lib/providerIcon";

/**
 * pi-ai 0.87.1 の builtin provider（41 件）と期待するロゴ。表から 1 行消えても・別のロゴへ書き換えても
 * 実画面は頭文字のタイルへ静かに落ちるだけなので、対応そのものをここで固定する（radius だけが意図的な fallback）。
 */
const BUILTIN_PROVIDER_ICONS: Record<string, string | null> = {
  "amazon-bedrock": "bedrock",
  "ant-ling": "antgroup",
  anthropic: "anthropic",
  "azure-openai-responses": "azure",
  baseten: "baseten",
  cerebras: "cerebras",
  "cloudflare-ai-gateway": "cloudflare",
  "cloudflare-workers-ai": "cloudflare",
  deepseek: "deepseek",
  fireworks: "fireworks",
  "github-copilot": "githubcopilot",
  google: "gemini",
  "google-vertex": "vertexai",
  groq: "groq",
  huggingface: "huggingface",
  "kimi-coding": "kimi",
  meta: "meta",
  minimax: "minimax",
  "minimax-cn": "minimax",
  mistral: "mistral",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  nvidia: "nvidia",
  openai: "openai",
  "openai-codex": "openai",
  opencode: "opencode",
  "opencode-go": "opencode",
  openrouter: "openrouter",
  "qwen-token-plan": "qwen",
  "qwen-token-plan-cn": "qwen",
  "qwen-token-plan-individual": "qwen",
  radius: null,
  together: "together",
  "vercel-ai-gateway": "vercel",
  xai: "xai",
  xiaomi: "xiaomimimo",
  "xiaomi-token-plan-ams": "xiaomimimo",
  "xiaomi-token-plan-cn": "xiaomimimo",
  "xiaomi-token-plan-sgp": "xiaomimimo",
  zai: "zai",
  "zai-coding-cn": "zai",
};

test("builtin provider の全 ID が期待どおりのロゴへ対応する", () => {
  assert.equal(Object.keys(BUILTIN_PROVIDER_ICONS).length, 41, "builtin provider は 41 件");
  for (const [provider, expected] of Object.entries(BUILTIN_PROVIDER_ICONS)) {
    assert.equal(providerIconKey(provider), expected, `${provider} のロゴ`);
  }
});

test("ロゴの無い provider は null（呼び出し側は頭文字へ落とす）", () => {
  assert.equal(providerIconKey("my-custom-provider"), null);
});

test("頭文字は名前の語頭を 2 つまで取り、名前が空なら id を使う", () => {
  assert.equal(providerMonogram("Amazon Bedrock", "amazon-bedrock"), "AB");
  assert.equal(providerMonogram("Faux", "faux"), "F");
  assert.equal(providerMonogram("", "my-provider"), "MP");
  assert.equal(providerMonogram("日本語", "ja"), "日");
});

test("頭文字は書記素で切り、結合文字を別の文字に割らない", () => {
  // 分解形の「がく」と「école」。コードポイントで切ると「かく」「EC」になる
  assert.equal(providerMonogram("か\u3099く", "custom"), "か\u3099");
  assert.equal(providerMonogram("e\u0301cole", "custom"), "E\u0301");
  // 結合文字を語の区切りにしない（語の頭文字 2 つは保つ）
  assert.equal(providerMonogram("か\u3099く 太郎", "custom"), "か\u3099太");
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

test("配布物へ LobeHub の帰属表示と MIT 許諾文を同梱する", () => {
  // パスの複製は許諾文の同梱が条件なので、public から配布物へ入るこのファイルが消えたら止める
  const notice = readFileSync(new URL("../public/THIRD_PARTY_NOTICES.txt", import.meta.url), "utf8");
  assert.ok(notice.includes("@lobehub/icons-static-svg 1.95.1"), "取り込んだパッケージを名指しする");
  assert.ok(notice.includes("Copyright (c) 2023 LobeHub"), "著作権表示を残す");
  assert.ok(notice.includes("Permission is hereby granted, free of charge"), "MIT 許諾文を残す");
});
