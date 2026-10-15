// WebSocket の到達判定 (server/src/browser/self-test.ts) の再試行の契約を検証する。
// 拒否された遷移の直後に Chromium が文書を差し替えると `evaluate` が「実行コンテキストが破棄された」で
// 落ちるため、その失敗だけを 1 回試し直す。他の失敗はそのまま返す (拒否の判定を甘くしない)。

import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { webSocketOutcome } from "../src/browser/self-test";

const DESTROYED = "page.evaluate: Execution context was destroyed, most likely because of a navigation";

interface FakePage {
  page: Page;
  evaluateCalls: number;
  loadStateWaits: number;
}

function fakePage(outcomes: Array<string | Error>): FakePage {
  const state: FakePage = {
    evaluateCalls: 0,
    loadStateWaits: 0,
    page: undefined as unknown as Page,
  };
  state.page = {
    evaluate: async () => {
      const outcome = outcomes[state.evaluateCalls];
      state.evaluateCalls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    waitForLoadState: async () => {
      state.loadStateWaits += 1;
    },
  } as unknown as Page;
  return state;
}

test("実行コンテキストが破棄されたときだけ、落ち着いてから 1 回試し直す", async () => {
  const retried = fakePage([new Error(DESTROYED), "closed"]);
  assert.equal(await webSocketOutcome(retried.page, "ws://192.0.2.1/ws", 1000), "closed");
  assert.equal(retried.evaluateCalls, 2, "1 回試し直す");
  assert.equal(retried.loadStateWaits, 1, "再試行の前に読み込みの落ち着きを待つ");

  const once = fakePage(["echoed"]);
  assert.equal(await webSocketOutcome(once.page, "ws://192.0.2.1/ws", 1000), "echoed");
  assert.equal(once.evaluateCalls, 1, "成功したら試し直さない");
});

test("破棄以外の失敗と、2 回続けての破棄はそのまま返す", async () => {
  const other = fakePage([new Error("Target page, context or browser has been closed")]);
  await assert.rejects(webSocketOutcome(other.page, "ws://192.0.2.1/ws", 1000), /Target page/);
  assert.equal(other.evaluateCalls, 1, "関係ない失敗では試し直さない");

  const twice = fakePage([new Error(DESTROYED), new Error(DESTROYED)]);
  await assert.rejects(webSocketOutcome(twice.page, "ws://192.0.2.1/ws", 1000), /Execution context was destroyed/);
  assert.equal(twice.evaluateCalls, 2, "試し直しは 1 回まで");
});
