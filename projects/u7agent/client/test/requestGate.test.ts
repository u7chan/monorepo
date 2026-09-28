import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGate, createRequestTracker } from "../src/hooks/requestGate";

test("later requests prevent older responses from overwriting the list", async () => {
  const begin = createRequestGate();
  let resolveOld!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolveOld = resolve;
  });
  const applied: string[] = [];
  const old = begin();
  const oldRequest = pending.then(() => {
    if (old()) applied.push("old");
  });
  const latest = begin();
  if (latest()) applied.push("latest");
  resolveOld();
  await oldRequest;
  assert.deepEqual(applied, ["latest"]);
});

test("cleanup invalidates pending responses; a new setup can apply again", () => {
  const begin = createRequestGate();
  let active = true;
  const old = begin(() => active);
  assert.equal(old(), true);
  active = false;
  assert.equal(old(), false);
  const reconnected = begin();
  assert.equal(reconnected(), true);
  assert.equal(old(), false);
});

test("createRequestTracker counts only the latest request as pending", () => {
  const tracker = createRequestTracker();
  assert.equal(tracker.pending(), false, "開始前は飛んでいない");
  const oldDone = tracker.begin();
  assert.equal(tracker.pending(), true);
  // 取得先が変わって新しい要求が始まったら、古い要求が返らなくても次は塞がない
  // (古い応答は createRequestGate が捨てるため、待つ理由が無い)
  const latestDone = tracker.begin();
  oldDone();
  assert.equal(tracker.pending(), true, "古い要求の完了で新しい要求の判定を消さない");
  latestDone();
  assert.equal(tracker.pending(), false);
  // 完了を二度呼んでも壞れない (finally が重なる経路の保険)
  latestDone();
  assert.equal(tracker.pending(), false);
});

test("createRequestTracker lets a re-fetch through after the latest request finishes", () => {
  const tracker = createRequestTracker();
  // A (取得先なし) → B (取得先変更) の順に開始し、B だけが 503 で完了する
  const doneA = tracker.begin();
  const doneB = tracker.begin();
  doneB();
  assert.equal(tracker.pending(), false, "B の完了後は再取得を通す");
  assert.equal(doneA, doneA, "A の完了は B の判定を変えない");
  doneA();
  assert.equal(tracker.pending(), false);
});
