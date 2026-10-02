import assert from "node:assert/strict";

import test from "node:test";
import { createFileRefRequests, fileRefRequestForSession } from "../src/lib/fileRefRequest";

test("未消費の要求は 1 件だけで、新しい要求が最新優先で残る", () => {
  const store = createFileRefRequests();
  assert.equal(store.snapshot(), null);
  store.request("a", "index.html");
  const first = store.snapshot();
  assert.deepEqual(first, { seq: 1, sessionId: "a", path: "index.html" });
  store.request("a", "nested/a.png");
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "a", path: "nested/a.png" });
  assert.ok((store.snapshot()?.seq ?? 0) > (first?.seq ?? 0), "seq が進んでいない");
});

test("ack は現在の要求と seq が一致するときだけ消す (request1 → request2 → ack1)", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  store.request("a", "nested/a.png");
  store.ack(1);
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "a", path: "nested/a.png" }, "古い ack で消えた");
  store.ack(2);
  assert.equal(store.snapshot(), null);
});

test("選択変更で破棄した後は、同じセッションに戻っても復活しない", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  store.clear();
  assert.equal(fileRefRequestForSession(store.snapshot(), "a"), null);
});

test("切替後に旧 ack が来ても新しい要求を消さない", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  store.clear();
  store.request("b", "b.png");
  store.ack(1);
  assert.deepEqual(store.snapshot(), { seq: 2, sessionId: "b", path: "b.png" });
});

test("sessionId が一致するときだけ子へ渡す", () => {
  const store = createFileRefRequests();
  store.request("a", "index.html");
  assert.deepEqual(fileRefRequestForSession(store.snapshot(), "a"), store.snapshot());
  assert.equal(fileRefRequestForSession(store.snapshot(), "b"), null);
  assert.equal(fileRefRequestForSession(null, "a"), null);
});

test("セッション未確定 (sessionId が空) の要求は捨てる", () => {
  const store = createFileRefRequests();
  store.request("", "index.html");
  assert.equal(store.snapshot(), null);
});

test("購読は変更のたびに届き、解除後は届かない", () => {
  const store = createFileRefRequests();
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  store.request("a", "index.html");
  store.ack(1);
  store.clear();
  assert.equal(notified, 2, "request と ack の両方で通知されていない");
  unsubscribe();
  store.request("a", "b.png");
  assert.equal(notified, 2);
});
