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

// DB に保存した実測は、SDK 記録値 (recorded) 用の「tok/s が揃わなければ出さない」ゲートを掛けない (What)。
// usage を報告しないプロバイダでも、再起動後に応答時間まで概算へ戻さないため。
test("DB に保存した実測は usage が無くても応答時間を出し、recorded とは別の由来として扱う", () => {
  const message = assistantMessage({ durationMs: 2000 });
  const assistantIds = new WeakMap<object, string>();
  assistantIds.set(message, "run-1:1");
  const saved = new Map<string, MessageMetrics>([["run-1:1", { durationMs: 1700, ttftMs: 700 }]]);
  const [projected] = projectMessages(
    sessionOf([message]),
    noMetrics(),
    masker,
    CWD,
    undefined,
    assistantIds,
    undefined,
    saved,
  );
  // source を省略する = 実測。DB 実測に ≈ を付けさせない
  assert.deepEqual(projected?.metrics, { durationMs: 1700, ttftMs: 700 });

  // tok/s を導出できた行は tok/s まで出す (live と同じ規則)
  const withTokens = new Map<string, MessageMetrics>([
    ["run-1:1", { durationMs: 1700, ttftMs: 700, tokensPerSecond: 80 }],
  ]);
  const [tokensProjected] = projectMessages(
    sessionOf([message]),
    noMetrics(),
    masker,
    CWD,
    undefined,
    assistantIds,
    undefined,
    withTokens,
  );
  assert.deepEqual(tokensProjected?.metrics, { durationMs: 1700, ttftMs: 700, tokensPerSecond: 80 });
});

test("metrics の解決順はメモリ実測 → DB 実測 → SDK 記録値", () => {
  const measuredFirst = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const savedSecond = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const recordedThird = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const messageMetrics = noMetrics();
  messageMetrics.set(measuredFirst, { durationMs: 1800, ttftMs: 900, tokensPerSecond: 50 });
  const assistantIds = new WeakMap<object, string>();
  assistantIds.set(measuredFirst, "run-1:1");
  assistantIds.set(savedSecond, "run-1:2");
  assistantIds.set(recordedThird, "run-1:3");
  const saved = new Map<string, MessageMetrics>([
    ["run-1:1", { durationMs: 1100 }],
    ["run-1:2", { durationMs: 1700, ttftMs: 700 }],
  ]);
  const projected = projectMessages(
    sessionOf([measuredFirst, savedSecond, recordedThird]),
    messageMetrics,
    masker,
    CWD,
    undefined,
    assistantIds,
    undefined,
    saved,
  );
  assert.deepEqual(projected[0]?.metrics, { durationMs: 1800, ttftMs: 900, tokensPerSecond: 50 });
  assert.deepEqual(projected[1]?.metrics, { durationMs: 1700, ttftMs: 700 }, "DB 実測が記録値より優先される");
  assert.deepEqual(projected[2]?.metrics, { durationMs: 2000, tokensPerSecond: 100, source: "recorded" });

  // 応答IDが引けない応答には DB 実測を当てない (間違った値を出すより出さない)
  const unknownId = assistantMessage({ usage: USAGE, durationMs: 2000 });
  const [unknown] = projectMessages(
    sessionOf([unknownId]),
    noMetrics(),
    masker,
    CWD,
    undefined,
    new WeakMap(),
    undefined,
    saved,
  );
  assert.deepEqual(unknown?.metrics, { durationMs: 2000, tokensPerSecond: 100, source: "recorded" });
});

test("未回答 ask_user の合成バブル向けメタにも DB 実測を使う", () => {
  const message = assistantMessage({ durationMs: 2000 });
  const assistantIds = new WeakMap<object, string>();
  assistantIds.set(message, "run-1:1");
  const saved = new Map<string, MessageMetrics>([["run-1:1", { durationMs: 1600 }]]);
  const meta = unprojectedAssistantMeta(
    [message],
    { messageMetrics: noMetrics(), assistantIds, savedMetrics: saved },
    new Set(["run-1:1"]),
  );
  assert.deepEqual(meta[0]?.metrics, { durationMs: 1600 });
});
