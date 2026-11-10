// BFF の close() が資格情報の書込完了を待つことの検証。stub pi を注入し、listen しない。
// 更新済みの refresh token を保存し損ねると、次回起動の認証が invalid_grant で失敗する。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { asPiBff, createStubPi } from "./stub-pi";

test("close() は資格情報の書込完了を待ってから返る", async () => {
  let settleCalls = 0;
  let release: () => void = () => {};
  const writing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(
      createStubPi({
        onSettleCredentialWrites: () => {
          settleCalls += 1;
          return writing;
        },
      }),
    ),
  });

  let closed = false;
  const closing = bff.close().then(() => {
    closed = true;
  });
  // close() の本体は同期に走り始めるため、待機の呼び出しはこの時点で観測できる
  assert.equal(settleCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "書込みが終わるまで close() は返らない");

  release();
  await closing;
  assert.equal(closed, true);
});
