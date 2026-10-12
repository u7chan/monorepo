// 応答のメタ行に足すターンの結末 (`Done · 1m 20s`) の描画。
// DOM 基盤が無いため react-dom/server の静的描画で固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Bubble } from "../src/lib/chatTypes";
import type { RunOutcome } from "../src/types";

// MessageView は AttachedFiles 経由で api.ts (location.origin を読む) を辿るため、先に shim を置く
globalThis.location ??= { origin: "http://localhost" } as Location;
const { MessageView } = await import("../src/components/chat/MessageView");

const bubble: Bubble = {
  id: 1,
  entryId: "m1",
  context: "active",
  role: "assistant",
  text: "本文",
  tools: [],
  skillLoads: [],
  at: 1_700_000_000_000,
  usage: {
    input: 8200,
    output: 512,
    cacheRead: 7900,
    cacheWrite: 300,
    reasoning: 128,
    totalTokens: 17_040,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0021 },
  },
  metrics: { durationMs: 2800, ttftMs: 900, tokensPerSecond: 228 },
};

function render(outcome?: RunOutcome): string {
  return renderToStaticMarkup(
    createElement(MessageView, {
      bubble,
      skillBadges: [],
      copied: false,
      singleColumn: false,
      rootCwd: "/workspace",
      onCopy: () => {},
      copiedId: "",
      copyFailure: () => undefined,
      onCopyTool: () => {},
      copiedAll: false,
      onCopyAll: () => {},
      turnEnd: outcome === undefined ? undefined : { outcome, durationMs: 80_000 },
    }),
  );
}

test("結末はメタ行の末尾に結末と時間を 1 つの量で出し、Done は緑にする", () => {
  // What: どれぐらいかかったかを先に読ませるため、結末と時間を同じ色の 1 セグメントにまとめる
  const html = render("completed");
  assert.ok(html.indexOf("228 tok/s") < html.indexOf("Done · 1m 20s"), "メタ行の数字より後ろに置く");
  assert.match(html, /text-ok-text[^>]*>Done · 1m 20s</);
});

test("異常の結末は warn / danger の色で残し、語でも区別できる状態を保つ", () => {
  assert.match(render("stopped"), /text-warn[^>]*>Stopped · 1m 20s</);
  assert.match(render("error"), /text-danger-text[^>]*>Failed · 1m 20s</);
});

test("結末のセグメントは二重読み上げを止め、時間の範囲を title で示す", () => {
  const segment = /<span([^>]*)>Done · 1m 20s<\/span>/.exec(render("completed"));
  assert.ok(segment, "1 つの span にまとめる");
  assert.ok(segment[1].includes('aria-live="off"'), "状態行の「完了」と同じ値の二重読み上げを止める");
  assert.ok(segment[1].includes('lang="en"'), "日本語 UI の中でここだけ英語");
  assert.ok(segment[1].includes("ツール実行を含む"), "ターン全体の値であることを hover で補う");
});

test("結末の値が無いターンではセグメントを出さない", () => {
  assert.ok(!render().includes("Done ·"), "値が無ければメタ行は今までどおり");
});
