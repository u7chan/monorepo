// セッション作成の in-flight 共有と破棄。同時アップロード / 送信で作成を 1 回に畳み、
// 新しい会話へ移ったら進行中の作成を捨てる (捨てないと前のセッションを掴む)。

import assert from "node:assert/strict";
import test from "node:test";
import { createSessionCreation } from "../src/hooks/sessionCreation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("shares one in-flight creation and starts a new one after it settles", async () => {
  const creation = createSessionCreation<string>();
  const first = deferred<string>();
  let calls = 0;

  const a = creation.start(() => {
    calls += 1;
    return first.promise;
  });
  const b = creation.start(() => {
    calls += 1;
    return Promise.resolve("unused");
  });

  assert.equal(calls, 1, "2 回目の start は作成を始めない");
  assert.equal(a, b, "同じ Promise を共有する");
  first.resolve("s-1");
  assert.equal(await a, "s-1");
  assert.equal(await b, "s-1");

  assert.equal(await creation.start(async () => "s-2"), "s-2", "完了後は新しく作る");
  assert.equal(calls, 1, "共有された呼び出しは create を呼ばない");
});

test("clear drops the in-flight creation so the next start does not reuse it", async () => {
  const creation = createSessionCreation<string>();
  const first = deferred<string>();
  const stale = creation.start(() => first.promise);

  // 新しい会話へ移った (進行中の作成は前のセッションのもの)
  creation.clear();
  const next = creation.start(async () => "s-2");
  assert.equal(await next, "s-2");

  // 古い作成が後から完了しても、新しい作成を握っている状態を壊さない
  first.resolve("s-1");
  assert.equal(await stale, "s-1");
  assert.equal(await creation.start(async () => "s-3"), "s-3");
});

test("a failed creation is not cached and is reported to every caller", async () => {
  const creation = createSessionCreation<string>();
  const failing = deferred<string>();
  const first = creation.start(() => failing.promise);
  const second = creation.start(async () => "unused");

  failing.reject(new Error("503"));
  await assert.rejects(first, /503/);
  await assert.rejects(second, /503/);
  // 失敗後は次の start が新しく作る
  assert.equal(await creation.start(async () => "s-2"), "s-2");
});
