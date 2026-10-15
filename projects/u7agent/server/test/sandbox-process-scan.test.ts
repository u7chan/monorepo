// 待受ソケットの観測 (server/src/sandbox/process-scan.ts) と GET /v1/procs/listeners を検証する。
// 実プロセスの fd を読むため、テスト自身が TCP を待受し、その PID と inode が返ることを固定する。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import { scanListeners } from "../src/sandbox/process-scan";

const TOKEN = "process-scan-token-0123456789abcdef";

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("scanListeners は待受 inode を返し、scan=true のときだけ所有 PID を特定する", async () => {
  const { server, port } = await listen();
  try {
    const quick = await scanListeners(port, { scan: false });
    assert.ok(quick.inodes.length > 0, "待受 inode を返す");
    assert.equal(quick.listener, null, "scan=false では PID を探さない");

    const scanned = await scanListeners(port, { scan: true });
    assert.deepEqual(scanned.inodes, quick.inodes);
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
  const { server, port } = await listen();
  await close(server);
  const scan = await scanListeners(port, { scan: true });
  assert.deepEqual(scan, { inodes: [], listener: null });
});

// 共有した /proc 読み取りが失敗しても、serve の起動確認・停止観測は観測済みの情報を返す契約の回帰。
// 待受中の自プロセスの stat だけ EACCES にしても、走査は打ち切って部分結果を返す (500 にしない)。
test("待受プロセスの stat を読めなくても観測は部分結果を返す", async () => {
  const { server, port } = await listen();
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
      listener: { pid: number; startedAt: number; ancestors: number[] } | null;
    };
    assert.deepEqual(body.inodes, scanned.inodes);
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
  const { server, port } = await listen();
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
      listener: { pid: number; inodes: number[]; ancestors: number[] } | null;
    };
    assert.ok(body.inodes.length > 0);
    assert.equal(body.listener?.pid, process.pid);
    assert.deepEqual(body.listener?.inodes, body.inodes);
  } finally {
    await close(server);
  }
});
