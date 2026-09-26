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

test("描画: 活動が無いときは活動欄を出さない (空行の折り返しを残さない)", () => {
  const html = render({ activity: "", context, model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash" });

  assert.ok(!html.includes("aria-live"), "活動欄ごと落とす");
  assert.ok(html.includes("GLM-5.3 Flash") && html.includes("Context"), "モデル名とゲージは残す");
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

// --- 手動圧縮の導線 ---

test("描画: セッションがあると Context ゲージの右に圧縮ボタンを出す", () => {
  const html = render({
    activity: "",
    context,
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
    onCompact: () => {},
  });

  const gaugeIndex = html.indexOf('aria-label="コンテキスト使用量"');
  const compactIndex = html.indexOf('aria-label="会話を圧縮"');
  assert.ok(gaugeIndex >= 0 && compactIndex > gaugeIndex, "モデル名 + ゲージと同じ組の右端に置く");
  assert.ok(html.includes('aria-label="圧縮の注意"'), "タップで開ける補足を持つ");
  // 注意書きは hover に頼らず DOM に出し、aria-describedby からも読めるようにする
  assert.ok(html.includes("元のメッセージは GUI から戻せません"));
  assert.ok(html.includes("composer-status-icon"), "36px の .icon-button ではなく状態行用の小さい variant");
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(described, "押す前に注意書きを読み上げへ渡す");
  assert.ok(html.includes(`id="${described}"`), "describedby の参照先が存在する");
  assert.ok(!html.includes("disabled"), "idle では押せる");
});

test("描画: ゲージが無くても (SDK 未対応) セッションがあれば圧縮ボタンを出す", () => {
  const html = render({ activity: "", model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash", onCompact: () => {} });

  assert.ok(!html.includes("Context"), "ゲージは出さない");
  assert.ok(html.includes('aria-label="会話を圧縮"'));
});

test("描画: 未作成チャット (onCompact なし) では圧縮ボタンも注意書きも出さない", () => {
  const html = render({ activity: "", context, model: "zai/glm-5.3-flash", modelLabel: "GLM-5.3 Flash" });

  assert.ok(!html.includes("会話を圧縮"));
  assert.ok(!html.includes("元のメッセージは GUI から戻せません"));
});

test("描画: 押せないときは disabled と理由を注意書きに載せる", () => {
  const html = render({
    activity: "会話を整理中…",
    context,
    model: "zai/glm-5.3-flash",
    modelLabel: "GLM-5.3 Flash",
    onCompact: () => {},
    compactDisabled: true,
    compactDisabledReason: "圧縮中",
  });

  assert.ok(html.includes('disabled=""'));
  assert.ok(html.includes("（圧縮中）"), "押せない理由を hover 以外でも読める形で出す");
});
