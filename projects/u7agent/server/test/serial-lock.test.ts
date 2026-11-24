import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedSerialLock, SerialLock } from "../src/serial-lock";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("SerialLock は実行中に同じロックへ追加したタスクも受付順で待たせる", async () => {
  const lock = new SerialLock();
  const started = deferred<void>();
  const release = deferred<void>();
  const order: string[] = [];
  let nested: Promise<string> | undefined;

  const first = lock.run(async () => {
    order.push("first starts");
    nested = lock.run(async () => {
      order.push("nested");
      return "nested result";
    });
    started.resolve();
    await release.promise;
    order.push("first finishes");
    return "first result";
  });
  const second = lock.run(async () => {
    order.push("second");
    return "second result";
  });

  await started.promise;
  assert.deepEqual(order, ["first starts"]);
  assert.ok(nested);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, nested]), ["first result", "second result", "nested result"]);
  assert.deepEqual(order, ["first starts", "first finishes", "second", "nested"]);
});

test("SerialLock は失敗をその呼び出し側に返し、後続を実行する", async () => {
  const lock = new SerialLock();
  const failure = new Error("first failed");
  const first = lock.run(async () => {
    throw failure;
  });
  const second = lock.run(async () => 42);

  await assert.rejects(first, (error) => error === failure);
  assert.equal(await second, 42);
});

test("KeyedSerialLock は同じキーだけを待たせ、最後の更新が戻るまでその末尾を公開する", async () => {
  const lock = new KeyedSerialLock<string>();
  assert.equal(lock.get("a"), undefined);

  const releaseFirst = deferred<number>();
  const releaseSecond = deferred<string>();
  let secondStarted = false;
  let secondSettled = false;
  const first = lock.run("a", () => releaseFirst.promise);
  const firstTail = lock.get("a");
  assert.ok(firstTail);
  const second = lock.run("a", () => {
    secondStarted = true;
    return releaseSecond.promise;
  });
  const secondTail = lock.get("a");
  assert.ok(secondTail);
  assert.notEqual(secondTail, firstTail);
  void secondTail.then(() => {
    secondSettled = true;
  });

  const other = lock.run("b", async () => "other");
  const otherTail = lock.get("b");
  assert.ok(otherTail);
  assert.deepEqual([...lock.values()], [secondTail, otherTail]);
  assert.equal(await other, "other");
  assert.equal(lock.has("b"), false);
  assert.equal(secondStarted, false);

  releaseFirst.resolve(1);
  assert.equal(await first, 1);
  assert.equal(await firstTail, undefined);
  assert.equal(lock.has("a"), true);
  assert.equal(lock.get("a"), secondTail);
  assert.equal(secondSettled, false);

  releaseSecond.resolve("second");
  assert.equal(await second, "second");
  assert.equal(lock.has("a"), false);
  assert.equal(lock.get("a"), undefined);
  assert.deepEqual([...lock.values()], []);
  assert.equal(await secondTail, undefined);
});

test("KeyedSerialLock は先行の失敗後も同じキーの後続を実行する", async () => {
  const lock = new KeyedSerialLock<string>();
  const failure = new Error("first failed");
  const first = lock.run("a", async () => {
    throw failure;
  });
  const second = lock.run("a", async () => 42);

  await assert.rejects(first, (error) => error === failure);
  assert.equal(await second, 42);
});

test("KeyedSerialLock は失敗時も外部の待機を reject せず、結果を返す前にキーを外す", async () => {
  const lock = new KeyedSerialLock<string>();
  const failure = new Error("last failed");
  const operation = lock.run("a", async () => {
    throw failure;
  });
  const tail = lock.get("a");
  assert.ok(tail);

  await assert.rejects(operation, (error) => {
    assert.equal(lock.has("a"), false);
    return error === failure;
  });
  assert.equal(await tail, undefined);
});
