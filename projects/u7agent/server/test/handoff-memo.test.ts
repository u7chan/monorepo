// 引き継ぎメモ (HANDOFF.md へ追記する 1 節) の組み立て。保存された entry だけを材料にし、
// 上限・件数・マスク・冪等化のハッシュを固定する。

import assert from "node:assert/strict";
import test from "node:test";
import { JST_TIME_ZONE } from "../src/jst";
import {
  buildHandoffSection,
  HANDOFF_CLOSING,
  HANDOFF_MESSAGE_MAX,
  HANDOFF_RECENT_MAX,
  HANDOFF_SECTION_MAX,
  handoffRecentMessages,
} from "../src/handoff-memo";
import { createSecretMasker, REDACTED } from "../src/redact";
import type { SessionEntryLike } from "../src/session-store";

const masker = createSecretMasker([]);
const SECRET = "sk-handoff-dummy-0123456789";
const maskingMasker = createSecretMasker([SECRET]);

function user(text: string): SessionEntryLike {
  return { type: "message", id: `u-${text}`, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(text: string): SessionEntryLike {
  return { type: "message", id: `a-${text}`, message: { role: "assistant", content: text } };
}

function compaction(summary: string, id = "c-1"): SessionEntryLike {
  return { type: "compaction", id, summary };
}

function build(entries: SessionEntryLike[], overrides: { title?: string; masker?: typeof masker; at?: number } = {}) {
  return buildHandoffSection({
    entries,
    title: overrides.title ?? "引き継ぐ会話",
    fromAgent: "汎用アシスタント",
    toAgent: "調査と実装",
    operationId: "abc12345",
    at: overrides.at ?? 0,
    masker: overrides.masker ?? masker,
  });
}

test("builds a section with the header, the latest summary, the recent exchanges, and the closing line", () => {
  const section = build([user("最初の依頼"), assistant("最初の応答"), compaction("ここまでの要約")]);
  assert.ok(section);
  assert.match(section.text, /^# 引き継ぎメモ \(本文ハッシュ: [0-9a-f]{16}\)\n/);
  assert.ok(section.text.includes("- 引き継ぎ: 汎用アシスタント → 調査と実装"));
  assert.ok(section.text.includes("- 元の会話タイトル: 引き継ぐ会話"));
  assert.ok(section.text.includes("## これまでの経緯\n\nここまでの要約"));
  assert.ok(section.text.includes("### user\n\n最初の依頼"));
  assert.ok(section.text.includes("### assistant\n\n最初の応答"));
  assert.ok(section.text.endsWith(`${HANDOFF_CLOSING}\n\n`));
  // ハッシュは材料から決まる (操作 ID と日時を含めない) ため、同じ材料なら同じ値になる
  const again = build([user("最初の依頼"), assistant("最初の応答"), compaction("ここまでの要約")]);
  assert.equal(again?.hash, section.hash);
  // 引き継ぎ先が変われば別の節になる (同じ材料でも同じハッシュにしない)
  const other = buildHandoffSection({
    entries: [user("最初の依頼"), assistant("最初の応答")],
    title: "引き継ぐ会話",
    fromAgent: "汎用アシスタント",
    toAgent: "別のエージェント",
    operationId: "abc12345",
    at: 0,
    masker,
  });
  const same = build([user("最初の依頼"), assistant("最初の応答")]);
  assert.notEqual(other?.hash, same?.hash);
});

test("writes the date in JST, which is the next day when the UTC date is the previous one", () => {
  const section = build([user("依頼")], { at: Date.parse("2026-10-16T15:49:53.419Z") });
  assert.ok(section);
  assert.ok(section.text.includes(`- 日時: 2026-10-17 00:49:53 (${JST_TIME_ZONE})`), section.text);
});

test("returns undefined when there is no message to write", () => {
  assert.equal(build([]), undefined);
  assert.equal(build([compaction("要約だけ")]), undefined);
});

test("keeps the newest six exchanges and truncates each message", () => {
  const entries = Array.from({ length: 9 }, (_, index) => user(`発言 ${index}`));
  const recent = handoffRecentMessages(entries, masker);
  assert.equal(recent.length, HANDOFF_RECENT_MAX);
  assert.deepEqual(
    recent.map((item) => item.text),
    ["発言 3", "発言 4", "発言 5", "発言 6", "発言 7", "発言 8"],
  );

  const long = handoffRecentMessages([user("あ".repeat(HANDOFF_MESSAGE_MAX + 100))], masker);
  assert.equal(long[0].text.length, HANDOFF_MESSAGE_MAX);
});

test("fits the section into the limit by dropping the oldest exchanges first", () => {
  const entries = Array.from({ length: 6 }, (_, index) => assistant(`発言${index} ${"あ".repeat(1100)}`));
  const section = build(entries);
  assert.ok(section);
  assert.ok(section.text.length <= HANDOFF_SECTION_MAX, `上限を超えている: ${section.text.length}`);
  assert.ok(section.text.includes("発言5"), "最新のやり取りが落ちている");
  assert.equal(section.text.includes("発言0"), false, "古いやり取りが落ちていない");
  assert.ok(section.text.startsWith("# 引き継ぎメモ"), "見出しが落ちている");
  assert.ok(section.text.endsWith(`${HANDOFF_CLOSING}\n\n`), "末尾の依頼行が落ちている");
});

test("masks the full strings before truncating (a secret crossing the boundary is removed)", () => {
  // 1,200 文字の上限をまたぐ位置に秘密値を置く (切る前に mask していなければ前半に残る)
  const text = `${"x".repeat(HANDOFF_MESSAGE_MAX - 10)}${SECRET}${"y".repeat(300)}`;
  const section = build([user(text), assistant("応答")], { masker: maskingMasker });
  assert.ok(section);
  assert.equal(section.text.includes(SECRET), false, "秘密の値がメモに残っている");
  assert.ok(section.text.includes(REDACTED));
  // 要約も同じく mask する
  const withSummary = build([compaction(`要約 ${SECRET}`), user("発言")], { masker: maskingMasker });
  assert.equal(withSummary?.text.includes(SECRET), false, "要約の秘密の値が残っている");
});
