// 待受ソケットの観測 (server/src/sandbox/process-scan.ts) と GET /v1/procs/listeners を検証する。
// 実プロセスの fd を読むため、テスト自身が TCP を待受し、その PID と inode が返ることを固定する。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import { listenAddressScope, scanListeners } from "../src/sandbox/process-scan";

const TOKEN = "process-scan-token-0123456789abcdef";

async function listenOn(host: string): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 指定ポートで待受を試す。使用中などで失敗したら null */
async function tryListen(port: number, host: string): Promise<Server | null> {
  const server = createServer();
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
  return bound ? server : null;
}

/**
 * 1 回のレンジ走査 (最大 100 ポート) に収まる 2 ポートを用意する。2 回目の listen(0) は上限の外へ
 * 落ちることが多いため、1 つ目の近傍で空いているポートを探して待受する。
 */
async function listenPair(): Promise<{ ports: [number, number]; closeAll: () => Promise<void> }> {
  const first = await listenOn("127.0.0.1");
  const opened: Server[] = [first.server];
  const closeAll = async () => {
    await Promise.all(opened.map((server) => close(server)));
  };
  for (let distance = 1; distance < 100; distance += 1) {
    for (const port of [first.port + distance, first.port - distance]) {
      if (port < 1 || port > 65535) continue;
      const second = await tryListen(port, "127.0.0.1");
      if (!second) continue;
      opened.push(second);
      return { ports: [first.port, port], closeAll };
    }
  }
  await closeAll();
  assert.fail("レンジ上限に収まる 2 ポートを用意できませんでした");
}

test("listenAddressScope は待受アドレスの 16 進を loopback / any / other に分ける", () => {
  // IPv4 は 32 bit を little-endian で並べた 8 桁
  assert.equal(listenAddressScope("0100007F"), "loopback");
  assert.equal(listenAddressScope("00000000"), "any");
  assert.equal(listenAddressScope("010200C0"), "other"); // 192.0.2.1

  // IPv6 は 32 bit ごとに little-endian で並べた 32 桁
  assert.equal(listenAddressScope("00000000000000000000000001000000"), "loopback"); // ::1
  assert.equal(listenAddressScope("00000000000000000000000000000000"), "any"); // ::
  assert.equal(listenAddressScope("0000000000000000FFFF0000010200C0"), "other"); // ::ffff:192.0.2.1

  // v4-mapped は IPv4 へ正規化してから判定する
  assert.equal(listenAddressScope("0000000000000000FFFF00000100007F"), "loopback"); // ::ffff:127.0.0.1
  assert.equal(listenAddressScope("0000000000000000FFFF000000000000"), "any"); // ::ffff:0.0.0.0

  assert.equal(listenAddressScope("0100007"), "other", "解釈できない桁数は安全側に倒す");
  assert.equal(listenAddressScope("0100007G"), "other", "解釈できない文字は安全側に倒す");
});

test("scanListeners は待受 inode を返し、scan=true のときだけ所有 PID を特定する", async () => {
  const { server, port } = await listenOn("127.0.0.1");
  try {
    const quick = await scanListeners(port, { scan: false });
    assert.ok(quick.inodes.length > 0, "待受 inode を返す");
    assert.equal(quick.listener, null, "scan=false では PID を探さない");
    assert.equal(quick.addressScopes.length, quick.inodes.length, "addressScopes は inodes と同じ並び");
    assert.deepEqual(
      quick.addressScopes,
      quick.inodes.map(() => "loopback"),
    );

    const scanned = await scanListeners(port, { scan: true });
    assert.deepEqual(scanned.inodes, quick.inodes);
    assert.deepEqual(scanned.addressScopes, quick.addressScopes);
    assert.ok(scanned.listener, "待受 PID を特定する");
    assert.equal(scanned.listener.pid, process.pid, "テスト自身が待受している");
    assert.ok(scanned.listener.startedAt > 0, "起動時刻を返す");
    assert.deepEqual(scanned.listener.inodes, scanned.inodes);
    assert.equal(scanned.listener.ancestors[0], process.pid, "祖先は自身から始まる");
  } finally {
    await close(server);
  }
});

test("scanListeners は待受の無いポートに空の inode と null を返す", async () => {
  const { server, port } = await listenOn("127.0.0.1");
  await close(server);
  const scan = await scanListeners(port, { scan: true });
  assert.deepEqual(scan, { inodes: [], addressScopes: [], listener: null });
});

for (const [host, scope] of [
  ["127.0.0.1", "loopback"],
  ["0.0.0.0", "any"],
  ["::ffff:127.0.0.1", "loopback"],
] as const) {
  test(`addressScopes は ${host} の待受を ${scope} として返す`, async () => {
    const { server, port } = await listenOn(host);
    try {
      const scan = await scanListeners(port, { scan: false });
      assert.ok(scan.inodes.length > 0, "待受 inode を返す");
      assert.deepEqual(
        scan.addressScopes,
        scan.inodes.map(() => scope),
      );
    } finally {
      await close(server);
    }
  });
}

// 共有した /proc 読み取りが失敗しても、serve の起動確認・停止観測は観測済みの情報を返す契約の回帰。
// 待受中の自プロセスの stat だけ EACCES にしても、走査は打ち切って部分結果を返す (500 にしない)。
test("待受プロセスの stat を読めなくても観測は部分結果を返す", async () => {
  const { server, port } = await listenOn("127.0.0.1");
  const originalReadFile = fs.readFile;
  try {
    const patched = async (path: string, ...rest: unknown[]): Promise<unknown> => {
      if (path === `/proc/${process.pid}/stat`) throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
      return (originalReadFile as unknown as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    };
    fs.readFile = patched as unknown as typeof fs.readFile;
    syncBuiltinESMExports();

    const scanned = await scanListeners(port, { scan: true });
    assert.ok(scanned.inodes.length > 0, "待受 inode は観測できる");
    assert.equal(scanned.listener?.pid, process.pid, "所有 PID は特定できる");
    assert.equal(scanned.listener?.startedAt, 0, "起動時刻は不明 (0) として返す");
    assert.deepEqual(scanned.listener?.ancestors, [process.pid], "読めない祖先で探索を打ち切る");

    const service = createSandboxService({ token: TOKEN, rootCwd: "/" });
    const response = await service.app.request(`/v1/procs/listeners?port=${port}&scan=true`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200, "読み取り失敗で 500 にしない");
    const body = (await response.json()) as {
      inodes: number[];
      addressScopes: string[];
      listener: { pid: number; startedAt: number; ancestors: number[] } | null;
    };
    assert.deepEqual(body.inodes, scanned.inodes);
    assert.deepEqual(body.addressScopes, scanned.addressScopes);
    assert.equal(body.listener?.pid, process.pid);
    assert.equal(body.listener?.startedAt, 0);
    assert.deepEqual(body.listener?.ancestors, [process.pid]);
  } finally {
    fs.readFile = originalReadFile;
    syncBuiltinESMExports();
    await close(server);
  }
});

test("GET /v1/procs/listeners は認証必須で、待受 inode と所有 PID を返す", async () => {
  const { server, port } = await listenOn("127.0.0.1");
  const service = createSandboxService({ token: TOKEN, rootCwd: "/" });
  try {
    const unauthorized = await service.app.request(`/v1/procs/listeners?port=${port}&scan=true`);
    assert.equal(unauthorized.status, 401);

    const invalid = await service.app.request("/v1/procs/listeners?port=0&scan=true", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "port must be a valid TCP port" });

    const response = await service.app.request(`/v1/procs/listeners?port=${port}&scan=true`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      inodes: number[];
      addressScopes: string[];
      listener: { pid: number; inodes: number[]; ancestors: number[] } | null;
    };
    assert.ok(body.inodes.length > 0);
    assert.deepEqual(
      body.addressScopes,
      body.inodes.map(() => "loopback"),
    );
    assert.equal(body.listener?.pid, process.pid);
    assert.deepEqual(body.listener?.inodes, body.inodes);
  } finally {
    await close(server);
  }
});

test("GET /v1/procs/listeners は from/to で待受ポートだけを返す", async () => {
  const { ports, closeAll } = await listenPair();
  const [from, to] = [Math.min(...ports), Math.max(...ports)];
  const service = createSandboxService({ token: TOKEN, rootCwd: "/" });
  const headers = { Authorization: `Bearer ${TOKEN}` };
  try {
    const wide = await service.app.request(`/v1/procs/listeners?from=${from}&to=${to}`, { headers });
    assert.equal(wide.status, 200);
    const wideBody = (await wide.json()) as { ports: { port: number; inodes: number[] }[] };
    const returned = wideBody.ports.map((entry) => entry.port);
    assert.ok(returned.includes(from), "レンジ内の 1 つ目の待受を返す");
    assert.ok(returned.includes(to), "レンジ内の 2 つ目の待受を返す");
    assert.equal("addressScopes" in wideBody, false, "レンジ応答に addressScopes は載せない");
    for (const entry of wideBody.ports) {
      assert.ok(entry.inodes.length > 0, "待受の無いポートは返さない");
      assert.deepEqual(
        entry.inodes,
        [...entry.inodes].sort((a, b) => a - b),
        "inode は昇順",
      );
    }

    // 範囲外の確認は片方だけを含む狭い範囲で行う (返る集合は他プロセスの待受に依るため固定しない)
    const narrow = await service.app.request(`/v1/procs/listeners?from=${from}&to=${from}`, { headers });
    assert.equal(narrow.status, 200);
    const narrowBody = (await narrow.json()) as { ports: { port: number; inodes: number[] }[] };
    assert.ok(
      narrowBody.ports.every((entry) => entry.port === from),
      "狭い範囲のポートだけを返す",
    );
    assert.ok(!narrowBody.ports.some((entry) => entry.port === to), "範囲外のポートは返さない");
  } finally {
    await closeAll();
  }
});

test("GET /v1/procs/listeners は不正な port / from / to を 400 で拒否する", async () => {
  const service = createSandboxService({ token: TOKEN, rootCwd: "/" });
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const request = (query: string) => service.app.request(`/v1/procs/listeners?${query}`, { headers });

  const unauthorized = await service.app.request("/v1/procs/listeners?from=1000&to=1001");
  assert.equal(unauthorized.status, 401, "レンジでも Bearer は必須");

  for (const query of [
    "from=1000",
    "to=1001",
    "from=1001&to=1000",
    "from=0&to=10",
    "from=1&to=65536",
    "from=1.5&to=2",
    "from=abc&to=2",
    "from=1&to=101",
  ]) {
    const response = await request(query);
    assert.equal(response.status, 400, query);
  }

  const exclusive = await request("port=8080&from=8080&to=8080");
  assert.equal(exclusive.status, 400, "port と from/to は排他");
  assert.deepEqual(await exclusive.json(), { error: "port and from/to are exclusive" });

  const scanWithRange = await request("from=1000&to=1100&scan=true");
  assert.equal(scanWithRange.status, 400, "レンジに fd 走査は載せない");
  assert.deepEqual(await scanWithRange.json(), { error: "scan is not supported with from/to" });
});
