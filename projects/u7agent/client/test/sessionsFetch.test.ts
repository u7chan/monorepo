// 一覧取得の状態と要求の採否。初回未取得 / 初回失敗 / 空の成功 / 失敗中の前回一覧 / 回復、
// 逆順完了、破棄された要求の loading 解除、失効 (スペース切替・unmount) を制御ロジックで固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { createSessionsFetch } from "../src/lib/sessionsFetch";

test("初回未取得・初回失敗・空の成功を区別する", () => {
  const fetch = createSessionsFetch();
  assert.deepEqual(fetch.snapshot(), { loaded: false, pending: false, failed: false });

  const failed = fetch.begin();
  assert.equal(fetch.snapshot().pending, true, "取得中は pending");
  failed.finish("failed");
  assert.deepEqual(fetch.snapshot(), { loaded: false, pending: false, failed: true }, "初回失敗は loaded 偽のまま");

  const succeeded = fetch.begin();
  succeeded.finish("applied", 1_000);
  assert.deepEqual(
    fetch.snapshot(),
    { loaded: true, pending: false, failed: false, lastSuccessAt: 1_000 },
    "空の成功も loaded を立て、失敗を解除する",
  );
});

test("2 回目以降の失敗は前回の成功時刻を保ち、回復で警告を消す", () => {
  const fetch = createSessionsFetch();
  fetch.begin().finish("applied", 1_000);
  const failed = fetch.begin();
  assert.equal(fetch.snapshot().pending, true);
  failed.finish("failed");
  assert.deepEqual(
    fetch.snapshot(),
    { loaded: true, pending: false, failed: true, lastSuccessAt: 1_000 },
    "前回の一覧と最終成功時刻を保つ",
  );
  fetch.begin().finish("applied", 2_000);
  assert.deepEqual(fetch.snapshot(), { loaded: true, pending: false, failed: false, lastSuccessAt: 2_000 });
});

test("逆順に完了した古い要求は状態を巻き戻さず、成功として扱わない", () => {
  const fetch = createSessionsFetch();
  const older = fetch.begin();
  const newer = fetch.begin();
  assert.equal(older.accepts(), false, "後から始めた要求だけが応答を適用できる");

  older.finish("applied", 1_000);
  assert.deepEqual(
    fetch.snapshot(),
    { loaded: false, pending: true, failed: false },
    "古い要求の成功で loaded を立てず、取得中も維持する",
  );
  newer.finish("applied", 2_000);
  assert.deepEqual(fetch.snapshot(), { loaded: true, pending: false, failed: false, lastSuccessAt: 2_000 });
});

test("古い要求の失敗で新しい要求の状態を上書きしない", () => {
  const fetch = createSessionsFetch();
  const older = fetch.begin();
  const newer = fetch.begin();
  newer.finish("applied", 2_000);
  older.finish("failed");
  assert.deepEqual(fetch.snapshot(), { loaded: true, pending: false, failed: false, lastSuccessAt: 2_000 });
});

test("破棄された要求でも取得中の解除は必ず行う", () => {
  const fetch = createSessionsFetch();
  const first = fetch.begin();
  const second = fetch.begin();
  first.finish("discarded");
  assert.equal(fetch.snapshot().pending, true, "まだ飛んでいる要求がある間は取得中のまま");
  second.finish("discarded");
  assert.equal(fetch.snapshot().pending, false);
});

test("失効した要求は応答を適用できず、状態も変えない", () => {
  const fetch = createSessionsFetch();
  const ticket = fetch.begin();
  fetch.invalidate();
  assert.equal(ticket.accepts(), false);
  ticket.finish("applied", 1_000);
  assert.deepEqual(
    fetch.snapshot(),
    { loaded: false, pending: false, failed: false },
    "unmount / スペース切替の後の応答は成功として扱わない",
  );
});

test("二重完了でも取得中の解除を 1 回だけ行う", () => {
  const fetch = createSessionsFetch();
  const ticket = fetch.begin();
  ticket.finish("applied", 1_000);
  ticket.finish("failed");
  assert.deepEqual(fetch.snapshot(), { loaded: true, pending: false, failed: false, lastSuccessAt: 1_000 });
});

test("購読は状態が変わったときだけ呼ばれ、解除できる", () => {
  const fetch = createSessionsFetch();
  let calls = 0;
  const unsubscribe = fetch.subscribe(() => {
    calls += 1;
  });
  const first = fetch.begin();
  assert.equal(calls, 1, "取得中の開始で 1 回");
  const second = fetch.begin();
  assert.equal(calls, 1, "既に取得中なら増えない");
  first.finish("discarded");
  assert.equal(calls, 1, "まだ飛んでいる間は取得中のまま");
  second.finish("applied", 1_000);
  assert.equal(calls, 2);
  unsubscribe();
  fetch.begin();
  assert.equal(calls, 2, "解除後は呼ばない");
});
