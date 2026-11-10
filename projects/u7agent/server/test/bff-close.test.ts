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
  // 待機を close() の最初の await に固定しない (契約は「返る前に待つ」だけ)。
  // 呼び出しの順序に依存せず待てるよう、stub 側から通知する
  let notifyCalled: () => void = () => {};
  const called = new Promise<void>((resolve) => {
    notifyCalled = resolve;
  });

  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(
      createStubPi({
        onSettleCredentialWrites: () => {
          settleCalls += 1;
          notifyCalled();
          return writing;
        },
      }),
    ),
  });

  let closed = false;
  const closing = bff.close().then(() => {
    closed = true;
  });
  await called;
  assert.equal(settleCalls, 1);
  // close() は書込とは別の後始末 (試行・ストア・アプリ DB の close) も await する。待機を外した実装は
  // ここで進み切って閉じるため、残りが終わる機会を与えてから「まだ閉じていない」ことを見る
  await allowCloseStepsToFinish(() => closed);
  assert.equal(closed, false, "書込みが終わるまで close() は返らない");

  release();
  await closing;
  assert.equal(closed, true);
});

/**
 * close() の残りが進み切るだけの時間を与える。待機を外した実装はこの間に閉じるため、
 * その場合は短絡して assertion の失敗位置を保つ
 */
async function allowCloseStepsToFinish(isClosed: () => boolean): Promise<void> {
  const deadline = Date.now() + 100;
  while (!isClosed() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
