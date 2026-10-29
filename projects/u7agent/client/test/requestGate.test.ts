import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerationTracker,
  createLoadingTracker,
  createRequestGate,
  createRequestTracker,
} from "../src/hooks/requestGate";

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

test("createLoadingTracker は破棄された要求の完了でも解除し、後続がある間は維持する", () => {
  const states: boolean[] = [];
  const tracker = createLoadingTracker((loading) => states.push(loading));
  // ミューテーションで応答が破棄されても、finally から完了が届けばフラグを解除する
  // (適用の可否で解除を分岐すると、ここで true が残って再取得を塞ぐ)
  const finishStale = tracker.begin();
  finishStale();
  // 後続が飛んでいる間は、古い方の完了では解除しない
  const finishOld = tracker.begin();
  const finishLatest = tracker.begin();
  finishOld();
  finishLatest();
  assert.deepEqual(states, [true, false, true, false]);
});

test("createLoadingTracker は同じ状態を重複して通知しない", () => {
  const states: boolean[] = [];
  const tracker = createLoadingTracker((loading) => states.push(loading));
  const finishA = tracker.begin();
  const finishB = tracker.begin();
  finishA();
  finishB();
  assert.deepEqual(states, [true, false], "2 件目の開始と 1 件目の完了では再通知しない");
});

test("createGenerationTracker は失効させた世代の応答を捨て、次の begin だけを通す", () => {
  const tracker = createGenerationTracker();
  const stale = tracker.begin();
  assert.equal(tracker.holds(stale), true);
  // 会話の切替 / 新規チャット / 引き継ぎ後の開き直しは、進行中の要求をまとめて失効させる
  tracker.invalidate();
  assert.equal(tracker.holds(stale), false, "失効した世代の応答を通している");
  const latest = tracker.begin();
  assert.equal(tracker.holds(stale), false);
  assert.equal(tracker.holds(latest), true);
  // 失効だけでは新しい要求を始めない (取得を待っている間に届いた応答を捨てるため)
  tracker.invalidate();
  assert.equal(tracker.holds(latest), false);
});

test("コピー結果は会話の切替で失効し、A→B・A→B→A のどちらでも古い成否を適用しない", async () => {
  // useMessageCopy と同じ形: コピー開始時に世代を取り、完了時に holds で適用可否を決める。
  // 所有部品の unmount (会話の切替) が invalidate を呼ぶ
  const gate = createGenerationTracker();
  const applied: string[] = [];
  const copy = (id: string, pending: Promise<"ok" | "error">) => {
    const token = gate.begin();
    return pending.then((result) => {
      if (gate.holds(token)) applied.push(`${id}:${result}`);
    });
  };

  let finishA!: (result: "ok" | "error") => void;
  const a = new Promise<"ok" | "error">((resolve) => {
    finishA = resolve;
  });
  const copyingA = copy("A", a);
  gate.invalidate();
  await copy("B", Promise.resolve("ok"));
  finishA("error");
  await copyingA;
  assert.deepEqual(applied, ["B:ok"], "切替後に前の会話のコピー失敗を表示している");

  // A → B → A: 戻ってきた A は新しい世代で、古い A の結果を拾わない
  applied.length = 0;
  let finishOldA!: (result: "ok" | "error") => void;
  const oldA = new Promise<"ok" | "error">((resolve) => {
    finishOldA = resolve;
  });
  const copyingOldA = copy("A", oldA);
  gate.invalidate();
  await copy("B", Promise.resolve("error"));
  gate.invalidate();
  await copy("A", Promise.resolve("ok"));
  finishOldA("ok");
  await copyingOldA;
  assert.deepEqual(applied, ["B:error", "A:ok"], "古い A の成功が戻ってきた A の表示を上書きしている");
});
