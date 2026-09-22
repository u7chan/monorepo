// 入力欄の上の状態行 (活動 / モデル / Context ゲージ) の描画。
// モデル名を出す条件と、読み上げに載せる範囲 (aria-live) を react-dom/server で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerStatus } from "../src/components/composer/ComposerStatus";

type Props = Parameters<typeof ComposerStatus>[0];

const render = (props: Props): string => renderToStaticMarkup(createElement(ComposerStatus, props));

const context = { tokens: 114000, contextWindow: 272000, percent: 42 };

test("描画: モデル名は表示名で出し、provider/id を title に持つ", () => {
  const html = render({ activity: "", model: "anthropic/claude-sonnet-4-5", modelLabel: "Claude Sonnet 4.5" });

  assert.ok(html.includes(">Claude Sonnet 4.5<"), "表示名を出す");
  assert.ok(html.includes('title="anthropic/claude-sonnet-4-5"'), "切り詰めたときのために provider/id を残す");
});

test("描画: 活動もコンテキストも無くても、モデルが解決できていれば行を出す", () => {
  const html = render({ activity: "", model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash" });

  assert.ok(html.includes(">GLM-5.3 Flash<"));
  assert.ok(!html.includes("Context"), "セッション未作成ではゲージを出さない");
});

test("描画: モデルも活動もコンテキストも無ければ何も出さない", () => {
  assert.equal(render({ activity: "" }), "");
});

test("描画: モデル名とゲージは aria-live の外へ置く", () => {
  const html = render({
    activity: "実行中…（タブを閉じても処理は続きます）",
    runningSince: Date.now(),
    context,
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
  });
  const liveStart = html.indexOf('aria-live="polite"');
  const liveEnd = html.indexOf("</span>", liveStart);
  const live = html.slice(liveStart, liveEnd);

  assert.ok(live.includes("実行中…（タブを閉じても処理は続きます）"), "活動テキストは読み上げる");
  assert.ok(!live.includes("GLM-5.3 Flash"), "モデル名は毎回読み上げない");
  assert.ok(!live.includes("Context"), "ゲージは毎回読み上げない");
  assert.ok(html.includes("(0s)"), "経過時間は aria-hidden の別スパンに出す");
});

test("描画: 利用できないモデルは warn 色にする", () => {
  const missing = render({ activity: "", model: "ghost/none", modelLabel: "ghost/none", modelUnavailable: true });
  const available = render({ activity: "", model: "ghost/none", modelLabel: "ghost/none" });

  assert.ok(missing.includes("text-warn"));
  assert.ok(!available.includes("text-warn"), "利用できるときは warn 色にしない");
});
