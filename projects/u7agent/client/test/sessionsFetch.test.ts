// 一覧取得の状態と要求の採否。初回未取得 / 初回失敗 / 空の成功 / 失敗中の前回一覧 / 回復、
// 取得中の要求の共有 (GET を積み上げない)、失効した要求の破棄と loading 解除、二重完了を制御ロジックで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createSessionsFetch } from "../src/lib/sessionsFetch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("初回未取得・初回失敗・空の成功を区別する", async () => {
  const fetch = createSessionsFetch<string[]>();
  assert.deepEqual(fetch.snapshot(), { loaded: false, pending: false, failed: false });

  const failing = fetch.load({
    fetch: async () => {
      throw new Error("503");
    },
    apply: () => {},
  });
  assert.equal(fetch.snapshot().pending, true, "取得中は pending");
  assert.equal(await failing, null);
  assert.deepEqual(fetch.snapshot(), { loaded: false, pending: false, failed: true }, "初回失敗は loaded 偽のまま");

  const applied: string[][] = [];
  const empty = fetch.load({ fetch: async () => [], apply: (data) => applied.push(data) });
  assert.deepEqual(await empty, [], "空の成功も成功として返す");
  assert.deepEqual(applied, [[]], "空でも適用する");
  const snapshot = fetch.snapshot();
  assert.equal(snapshot.loaded, true, "空の成功でも loaded を立てる");
  assert.equal(snapshot.failed, false, "成功で失敗を解除する");
  assert.equal(snapshot.pending, false);
  assert.equal(typeof snapshot.lastSuccessAt, "number");
});

test("2 回目以降の失敗は前回の成功時刻を保ち、回復で警告を消す", async () => {
  const fetch = createSessionsFetch<string[]>();
  await fetch.load({ fetch: async () => ["a"], apply: () => {} });
  const lastSuccessAt = fetch.snapshot().lastSuccessAt;

  const failed = await fetch.load({
    fetch: async () => {
      throw new Error("timeout");
    },
    apply: () => {},
  });
  assert.equal(failed, null);
  assert.deepEqual(fetch.snapshot(), { loaded: true, pending: false, failed: true, lastSuccessAt });

  await fetch.load({ fetch: async () => ["b"], apply: () => {} });
  assert.equal(fetch.snapshot().failed, false);
  assert.equal(fetch.snapshot().loaded, true);
});

test("取得中の再要求は同じ GET を共有し、遅い応答でも初回成功を捨てない", async () => {
  const fetch = createSessionsFetch<string[]>();
  const response = deferred<string[]>();
  let requests = 0;
  const applied: string[][] = [];
  const load = () =>
    fetch.load({
      fetch: () => {
        requests += 1;
        return response.promise;
      },
      apply: (data) => applied.push(data),
    });

  // 一覧の応答が 5 秒遅れ、4 秒ポーリング・SSE・画面オープン・再読み込みが重なる状況を再現する
  const calls = [load(), load(), load(), load(), load()];
  assert.equal(requests, 1, "取得中は新しい GET を出さない");
  assert.equal(fetch.snapshot().pending, true);

  response.resolve(["session-1"]);
  const results = await Promise.all(calls);
  assert.equal(requests, 1, "応答が返るまで GET は 1 本のまま");
  assert.deepEqual(applied, [["session-1"]], "適用は 1 回だけ");
  for (const result of results) assert.deepEqual(result, ["session-1"], "共有した呼び出しにも結果を返す");
  assert.equal(fetch.snapshot().loaded, true, "遅い応答でも初回成功を捨てない");
  assert.equal(fetch.snapshot().pending, false);

  // 完了後の要求は新しい GET を出す (完了済みの Promise を共有しない)
  await load();
  assert.equal(requests, 2);
});

test("変更後の取り直しは進行中の要求を追い越し、古い一覧を適用しない", async () => {
  const fetch = createSessionsFetch<string[]>();
  const older = deferred<string[]>();
  const applied: string[][] = [];
  const before = fetch.load({ fetch: () => older.promise, apply: (data) => applied.push(data) });

  // 作成 / 削除 / 移動 / 送信の直後は、変更前の一覧を返す要求に相乗りせず新しい GET を出す
  const after = fetch.load({ fetch: async () => ["after"], apply: (data) => applied.push(data) }, { supersede: true });
  assert.deepEqual(await after, ["after"]);
  assert.deepEqual(applied, [["after"]], "新しい一覧を先に適用する");

  older.resolve(["before"]);
  assert.equal(await before, null, "追い越された要求は成功として返さない");
  assert.deepEqual(applied, [["after"]], "古い一覧で上書きしない");
});

test("失効した要求が後から完了しても、新しい要求の成功を巻き戻さない", async () => {
  const fetch = createSessionsFetch<string[]>();
  const older = deferred<string[]>();
  const newer = deferred<string[]>();
  const applied: string[][] = [];
  const first = fetch.load({ fetch: () => older.promise, apply: (data) => applied.push(data) });

  fetch.invalidate();
  const second = fetch.load({ fetch: () => newer.promise, apply: (data) => applied.push(data) });
  newer.resolve(["new"]);
  assert.deepEqual(await second, ["new"]);
  assert.equal(fetch.snapshot().loaded, true);

  // 失効した要求が後から成功しても、適用も状態変更もしない
  older.resolve(["old"]);
  assert.equal(await first, null);
  assert.deepEqual(applied, [["new"]]);
  assert.equal(fetch.snapshot().loaded, true);
  assert.equal(fetch.snapshot().failed, false);
});

test("失効した要求の完了は、新しい要求の取得中を解除しない", async () => {
  const fetch = createSessionsFetch<string[]>();
  const older = deferred<string[]>();
  const newer = deferred<string[]>();
  const first = fetch.load({ fetch: () => older.promise, apply: () => {} });
  fetch.invalidate();
  const second = fetch.load({ fetch: () => newer.promise, apply: () => {} });

  older.resolve(["old"]);
  await first;
  assert.equal(fetch.snapshot().pending, true, "新しい要求がまだ飛んでいる");
  newer.resolve(["new"]);
  await second;
  assert.equal(fetch.snapshot().pending, false, "最後の要求の完了で解除する");
});

test("失効した要求の失敗で、新しい要求の状態を上書きしない", async () => {
  const fetch = createSessionsFetch<string[]>();
  const older = deferred<string[]>();
  const newer = deferred<string[]>();
  const first = fetch.load({ fetch: () => older.promise, apply: () => {} });
  fetch.invalidate();
  const second = fetch.load({ fetch: () => newer.promise, apply: () => {} });

  newer.resolve(["new"]);
  await second;
  older.reject(new Error("late failure"));
  await first;
  assert.equal(fetch.snapshot().failed, false);
  assert.equal(fetch.snapshot().loaded, true);
});

test("同期例外でも取得中の解除を行い、決着済みの要求を共有しない", async () => {
  const fetch = createSessionsFetch<string[]>();
  const failed = await fetch.load({
    fetch: () => {
      throw new Error("sync");
    },
    apply: () => {},
  });
  assert.equal(failed, null);
  assert.deepEqual(fetch.snapshot(), { loaded: false, pending: false, failed: true });

  // 決着済みの Promise を相乗りさせず、次の要求は新しい GET を出す
  let requests = 0;
  await fetch.load({
    fetch: async () => {
      requests += 1;
      return ["ok"];
    },
    apply: () => {},
  });
  assert.equal(requests, 1);
  assert.equal(fetch.snapshot().loaded, true);
});

test("購読は状態が変わったときだけ呼ばれ、解除できる", async () => {
  const fetch = createSessionsFetch<string[]>();
  let calls = 0;
  const unsubscribe = fetch.subscribe(() => {
    calls += 1;
  });
  const response = deferred<string[]>();
  const load = () => fetch.load({ fetch: () => response.promise, apply: () => {} });
  const first = load();
  assert.equal(calls, 1, "取得中の開始で 1 回");
  void load();
  assert.equal(calls, 1, "既に取得中なら増えない");
  response.resolve(["a"]);
  await first;
  assert.equal(calls, 2);
  unsubscribe();
  await load();
  assert.equal(calls, 2, "解除後は呼ばない");
});
