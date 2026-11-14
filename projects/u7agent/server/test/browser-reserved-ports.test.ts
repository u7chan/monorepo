// ブラウザの待受を指定ポートへ固定できることを、Chromium を使わずに固定する。
// サンドボックスでは Landlock が接続先ポートしか制限できないため、proxy / fixture / 閉じた検証用の
// 3 つが呼び出しごとの予約レンジ内で待ち受ける必要がある (server/src/browser/ports.ts)。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { reserveClosedPort, startLoopbackFixture } from "../src/browser/fixture";
import { startDenyAllProxy } from "../src/browser/proxy";

/** 空いているポートを 1 つ取る (bind して閉じるだけ。テストの間は誰も使わない前提) */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("空きポートを取得できません");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("proxy と fixture は指定したポートで待ち受ける", async () => {
  const proxyPort = await freePort();
  const fixturePort = await freePort();
  const proxy = await startDenyAllProxy({ port: proxyPort });
  const fixture = await startLoopbackFixture({ port: fixturePort });
  try {
    assert.equal(proxy.port, proxyPort);
    assert.equal(proxy.server, `http://127.0.0.1:${proxyPort}`);
    assert.equal(new URL(fixture.origin).port, String(fixturePort));
    // 実際にそのポートで応答することまで見る (listen の引数だけを信じない)
    const response = await fetch(`${fixture.origin}/`);
    assert.equal(response.status, 200);
  } finally {
    await proxy.close();
    await fixture.close();
  }
});

test("閉じた検証用ポートは指定でき、接続は失敗する", async () => {
  const closedPort = await freePort();
  assert.equal(await reserveClosedPort(closedPort), closedPort);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(closedPort, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("閉じたポートが接続を受け付けました"));
    });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
  });
});

test("閉じた検証用ポートが使用中なら fail-closed で失敗する", async () => {
  const fixture = await startLoopbackFixture({ port: await freePort() });
  try {
    await assert.rejects(reserveClosedPort(Number(new URL(fixture.origin).port)));
  } finally {
    await fixture.close();
  }
});
