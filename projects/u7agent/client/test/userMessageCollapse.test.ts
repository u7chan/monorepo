import assert from "node:assert/strict";

import test from "node:test";
import { estimateChatItemHeight } from "../src/lib/chatItems";
import type { Bubble } from "../src/lib/chatTypes";
import { measureUserMessageClamp, USER_MESSAGE_CLAMP_PX } from "../src/lib/userMessage";

function bubble(role: Bubble["role"], text: string): Bubble {
  return { id: 1, entryId: "e1", context: "active", role, text, tools: [], skillLoads: [] };
}

test("見積り: user の長文は clamp の高さで頭打ちになる", () => {
  const long = "あ".repeat(3000);
  const user = estimateChatItemHeight({ kind: "message", key: "m", bubble: bubble("user", long) });
  const assistant = estimateChatItemHeight({ kind: "message", key: "m", bubble: bubble("assistant", long) });
  assert.equal(user, 64 + USER_MESSAGE_CLAMP_PX);
  assert.ok(user < assistant, "user の折りたたみが仮想スクロールの見積りに効いていない");
});

test("計測: 収まっているうちは clamp しない", () => {
  assert.deepEqual(measureUserMessageClamp({ scrollHeight: 180, clientHeight: 180, clampHeight: 0 }), {
    clampHeight: 0,
    clamped: false,
  });
});

test("計測: あふれた時点の clientHeight を clamp の高さとして固定する", () => {
  const first = measureUserMessageClamp({ scrollHeight: 1500, clientHeight: 240, clampHeight: 0 });
  assert.deepEqual(first, { clampHeight: 240, clamped: true });
  // 縮小の遷移中は clientHeight がまだ全文の高さに近い。確定済みの clamp の高さと比べるので、
  // ボタンが一瞬消える判定 (clamped: false) にならない
  assert.deepEqual(measureUserMessageClamp({ scrollHeight: 1500, clientHeight: 1500, clampHeight: 240 }), {
    clampHeight: 240,
    clamped: true,
  });
});

test("計測: 幅が広がって収まったら clamp を外す", () => {
  assert.deepEqual(measureUserMessageClamp({ scrollHeight: 200, clientHeight: 200, clampHeight: 240 }), {
    clampHeight: 240,
    clamped: false,
  });
});
