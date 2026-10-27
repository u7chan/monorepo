// 応答メタの投影。SDK が履歴へ記録した durationMs からの概算を、BFF の実測が無い応答にだけ載せ、
// 由来を source で示すことを固定する (復元した会話でも時間と tok/s が出る前提)。
import assert from "node:assert/strict";
import test from "node:test";
import { createSecretMasker } from "../src/redact";
import type { PiSessionLike } from "../src/pi-runtime";
import type { MessageMetrics, Usage } from "../src/schema";
import { projectMessages, unprojectedAssistantMeta } from "../src/session-projection";

const CWD = "/tmp/project";
const masker = createSecretMasker([]);

const USAGE: Usage = {
  input: 1000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type TestMessage = PiSessionLike["messages"][number];

function sessionOf(messages: TestMessage[]): PiSessionLike {
  return { messages } as unknown as PiSessionLike;
}

const noMetrics = () => new WeakMap<object, MessageMetrics>();

function assistantMessage(extra: Partial<TestMessage> = {}): TestMessage {
  return { role: "assistant", content: [{ type: "text", text: "応答" }], timestamp: 2, ...extra };
}

test("metrics が無い応答は SDK 記録値から応答時間を導出し、由来を recorded にする", () => {
  const message = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const [projected] = projectMessages(sessionOf([message]), noMetrics(), masker, CWD);
  assert.deepEqual(projected?.metrics, { durationMs: 2000, tokensPerSecond: 100, source: "recorded" });
});

test("BFF の実測がある応答には記録値を使わない", () => {
  const message = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const measured = noMetrics();
  measured.set(message, { durationMs: 1800, ttftMs: 900, tokensPerSecond: 50 });
  const [projected] = projectMessages(sessionOf([message]), measured, masker, CWD);
  assert.deepEqual(projected?.metrics, { durationMs: 1800, ttftMs: 900, tokensPerSecond: 50 });
});

test("記録値が無い / 0 / usage 未報告の応答には応答時間を載せない", () => {
  const cases: TestMessage[] = [
    assistantMessage({ usage: USAGE }),
    assistantMessage({ usage: USAGE, durationMs: 0 }),
    assistantMessage({ durationMs: 2000 }),
  ];
  for (const message of cases) {
    const [projected] = projectMessages(sessionOf([message]), noMetrics(), masker, CWD);
    assert.equal(projected?.metrics, undefined, `metrics を載せている: ${JSON.stringify(message)}`);
  }
});

test("未回答 ask_user の合成バブル向けメタにも記録値の概算を載せる", () => {
  const message = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const assistantIds = new WeakMap<object, string>();
  assistantIds.set(message, "run-1:1");
  const meta = unprojectedAssistantMeta([message], { messageMetrics: noMetrics(), assistantIds }, new Set(["run-1:1"]));
  assert.deepEqual(meta[0]?.metrics, { durationMs: 2000, tokensPerSecond: 100, source: "recorded" });
});
