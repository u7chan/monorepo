// deny-all proxy (server/src/browser/proxy.ts) を検証する。
// ブラウザのネットワーク層で止めるのが本命の境界なので、HTTP / CONNECT / Upgrade のどれも通さないことが契約。

import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import { startDenyAllProxy } from "../src/browser/proxy";

/** 生のソケットで書き、相手が閉じるまで読む (proxy へ届く要求は絶対形式なので、生のテキストで作る) */
async function rawExchange(port: number, request: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(request);
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test("deny-all proxy は 127.0.0.1 の一時ポートで待受し、HTTP を拒否する", async () => {
  const denials: string[] = [];
  const proxy = await startDenyAllProxy({ onDeny: (target) => denials.push(target) });
  try {
    assert.ok(proxy.server.startsWith("http://127.0.0.1:"), proxy.server);
    const response = await rawExchange(
      proxy.port,
      ["GET http://example.com/ HTTP/1.1", "Host: example.com", "Connection: close", "", ""].join("\r\n"),
    );
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.match(response, /ループバック以外への通信は拒否します/);
    assert.deepEqual(denials, ["http://example.com/"]);
  } finally {
    await proxy.close();
  }
});

test("deny-all proxy は CONNECT と Upgrade も拒否する", async () => {
  const denials: string[] = [];
  const proxy = await startDenyAllProxy({ onDeny: (target) => denials.push(target) });
  try {
    const connectResponse = await rawExchange(
      proxy.port,
      ["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", "", ""].join("\r\n"),
    );
    assert.match(connectResponse, /^HTTP\/1\.1 403 /);

    const upgradeResponse = await rawExchange(
      proxy.port,
      [
        "GET http://example.com/ws HTTP/1.1",
        "Host: example.com",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    assert.match(upgradeResponse, /^HTTP\/1\.1 403 /);
    assert.deepEqual(denials, ["example.com:443", "http://example.com/ws"]);
  } finally {
    await proxy.close();
  }
});
