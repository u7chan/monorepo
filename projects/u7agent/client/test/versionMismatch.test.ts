// 版ずれの判定。どの組み合わせで案内を出すかは、health の buildId とビルド時の識別子だけで決まる。

import assert from "node:assert/strict";
import test from "node:test";
import { clientBuildId, createVersionMismatchTracker, versionMismatchOf } from "../src/lib/versionMismatch";

test("同じ識別子なら版ずれにしない", () => {
  assert.equal(versionMismatchOf("0.1.0+abc1234", "0.1.0+abc1234"), false);
});

test("識別子が違えば版ずれにする", () => {
  assert.equal(versionMismatchOf("0.1.0+abc1234", "0.1.0+def5678"), true);
  assert.equal(versionMismatchOf("fixture-client", "fixture-server"), true);
});

test("識別子が取れないときは出さない (dev サーバー / ビルド外 / 旧サーバー)", () => {
  // client 側が空 = dev サーバーでビルド識別子を埋めていない
  assert.equal(versionMismatchOf("", "0.1.0+abc1234"), false);
  // server 側が無い = 旧サーバーが buildId を返さない
  assert.equal(versionMismatchOf("0.1.0+abc1234", undefined), false);
  assert.equal(versionMismatchOf("0.1.0+abc1234", null), false);
  assert.equal(versionMismatchOf("0.1.0+abc1234", ""), false);
  assert.equal(versionMismatchOf("", ""), false);
});

test("前後の空白だけの違いは識別子の違いとして扱わない", () => {
  assert.equal(versionMismatchOf(" 0.1.0+abc1234 ", "0.1.0+abc1234"), false);
  assert.equal(versionMismatchOf("0.1.0+abc1234", "  "), false);
});

test("ビルド識別子を埋めていない環境 (テスト / tsc) では client 側が空になる", () => {
  assert.equal(clientBuildId(), "");
});

test("判定の保持は、一度出したら health の失敗や取り直しで消えない", () => {
  const tracker = createVersionMismatchTracker("client-a");
  assert.equal(tracker.check(undefined), false, "health を取れていない時点で出している");
  assert.equal(tracker.check("server-a"), true, "食い違いを見落としている");
  // 取り直しの失敗 (null) や同じ組み合わせの再取得で結論を戻さない
  assert.equal(tracker.check(null), true);
  assert.equal(tracker.check("server-a"), true);
});

test("判定の保持は、識別子が揃っている間は出さない", () => {
  const tracker = createVersionMismatchTracker("client-a");
  assert.equal(tracker.check("client-a"), false);
  assert.equal(tracker.check(undefined), false, "取得できないだけで出している");
});
