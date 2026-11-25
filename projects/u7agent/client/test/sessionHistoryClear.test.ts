import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_CLEAR_CLEANUP_NOTE,
  historyClearBlockedReason,
  historyClearedBetween,
  sessionHistoryClearConfirmRequest,
  withoutOldHistory,
} from "../src/lib/sessionHistoryClear";
import type { SessionPayload } from "../src/types";

const idle = { status: "idle" as const, queueDepth: 0 };

test("実行中・回答待ち・キュー待ち・圧縮中は履歴を消せない", () => {
  assert.equal(historyClearBlockedReason(idle), "", "idle は実行できる");
  for (const status of ["running", "queued", "compacting"] as const) {
    assert.match(historyClearBlockedReason({ status, queueDepth: 0 }), /実行中・回答待ち/);
  }
  assert.match(historyClearBlockedReason({ ...idle, queueDepth: 1 }), /実行中・回答待ち/);
  assert.match(historyClearBlockedReason({ ...idle, awaitingAnswer: true }), /実行中・回答待ち/);
  // 終端は依頼中ではない (サーバーの isBusy と同じ集合)
  for (const status of ["completed", "stopped", "error"] as const) {
    assert.equal(historyClearBlockedReason({ status, queueDepth: 0 }), "");
  }
});

test("片付け待ちは引き継ぎと履歴で区別した理由を出す", () => {
  const handoff = historyClearBlockedReason({ ...idle, handoffCleanup: true });
  assert.match(handoff, /引き継ぎの片付け/);
  const history = historyClearBlockedReason({ ...idle, historyCleanup: true });
  assert.match(history, /クリアの片付け/);
  assert.notEqual(handoff, history);
});

test("確認は対象の会話と、消えるもの / 残るものを示す", () => {
  const request = sessionHistoryClearConfirmRequest("決済画面の検証");
  assert.equal(request.kind, "confirm");
  assert.equal(request.title, "会話履歴をクリア");
  assert.deepEqual(request.subject, { label: "対象の会話", value: "決済画面の検証" });
  assert.equal(request.confirmLabel, "履歴をクリア");
  assert.ok(request.danger, "元に戻せない操作なので danger にする");
  const body = request.body?.join("\n") ?? "";
  assert.match(body, /未送信/);
  assert.match(body, /自動で付いたタイトル/);
  assert.match(body, /元に戻せません/);
  assert.match(body, /同じ URL/);
  assert.match(body, /作業フォルダのファイル・添付・HANDOFF\.md は残ります/);
  // 一覧が古くてタイトルが取れない行でも確認は出す
  assert.equal(sessionHistoryClearConfirmRequest("").subject, undefined);
  assert.match(HISTORY_CLEAR_CLEANUP_NOTE, /片付け/);
});

test("同じ会話で履歴世代が変わったときだけクリアとみなす", () => {
  const scope = { sessionId: "s-1", generation: "aaaa" };
  assert.equal(historyClearedBetween(scope, { sessionId: "s-1", historyGeneration: "bbbb" }), true);
  // 旧データ (空文字) から新しい世代へ変わった場合もクリア
  assert.equal(
    historyClearedBetween({ sessionId: "s-1", generation: "" }, { sessionId: "s-1", historyGeneration: "bbbb" }),
    true,
  );
  // 同じ世代 / 別の会話への切替 / 会話を開く前は、履歴が変わっていない
  assert.equal(historyClearedBetween(scope, { sessionId: "s-1", historyGeneration: "aaaa" }), false);
  assert.equal(historyClearedBetween(scope, { sessionId: "s-2", historyGeneration: "bbbb" }), false);
  assert.equal(
    historyClearedBetween({ sessionId: "", generation: "" }, { sessionId: "s-1", historyGeneration: "bbbb" }),
    false,
  );
});

test("クリアの resync から旧履歴の値 (メッセージ・圧縮・未送信・実行) を落とす", () => {
  const payload = {
    sessionId: "s-1",
    piSessionId: "s-1",
    cwd: "",
    eventGeneration: "g",
    historyGeneration: "h",
    status: "running",
    title: "",
    createdAt: 0,
    lastUsedAt: 0,
    serverNow: 0,
    queueDepth: 2,
    pendingSends: [{ sendId: "x", text: "旧未送信", at: 0, state: "unsent" }],
    pinned: false,
    lastSeq: 3,
    run: { id: "r", initialSendId: "x", status: "running", startedAt: 0, toolCalls: [], totalRetryCount: 0 },
    messages: [{ id: "m", role: "user", text: "旧メッセージ", at: 0 }],
    assistantMeta: [{ assistantId: "a" }],
    compactions: [{ id: "c", summary: "旧要約", firstKeptEntryId: "m", tokensBefore: 1 }],
    context: { tokens: 10, contextWindow: 100, percent: 10 },
  } as unknown as SessionPayload;
  const cleared = withoutOldHistory(payload);
  assert.deepEqual(cleared.messages, []);
  assert.deepEqual(cleared.compactions, []);
  assert.deepEqual(cleared.pendingSends, []);
  assert.equal(cleared.run, null);
  assert.equal(cleared.queueDepth, 0);
  assert.equal(cleared.status, "idle");
  assert.equal(cleared.assistantMeta, undefined);
  assert.equal(cleared.context, undefined);
  // 会話の識別子と新しい履歴世代は残す
  assert.equal(cleared.sessionId, "s-1");
  assert.equal(cleared.historyGeneration, "h");
});
