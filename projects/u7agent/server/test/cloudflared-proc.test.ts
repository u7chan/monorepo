// /proc を読む 2 つの観測 (プロセスの素性と、メトリクスの待受の所有) を検証する。
// 実プロセスは起こさない。自分自身と、偽の /proc の木 (一時ディレクトリ) で見る。

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loopbackListenerOwner, readProcessReading } from "../src/cloudflared";

const LINUX_ONLY = { skip: process.platform !== "linux" };

test("実際の /proc から、自分自身の実体・作業ディレクトリ・引数・起動時刻を読む", LINUX_ONLY, async () => {
  const reading = await readProcessReading(process.pid);
  assert.equal(reading.state, "present");
  if (reading.state !== "present") return;
  assert.equal(reading.exe, await realpath(process.execPath));
  assert.equal(reading.cwd, await realpath(process.cwd()));
  assert.ok(reading.argv.length > 0);
  assert.ok(reading.startedAtMs > 0 && reading.startedAtMs <= Date.now());
});

test("存在しない pid は gone", LINUX_ONLY, async () => {
  assert.deepEqual(await readProcessReading(2 ** 30), { state: "gone" });
});

const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const line = (local: string, state: string, inode: number) =>
  `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

/** 偽の /proc。tcp / tcp6 の表と、pid ごとの fd (socket:[inode] を指す symlink) を作る */
async function fakeProc(input: { tcp?: string[]; tcp6?: string[]; fds?: Record<number, number[]> }) {
  const root = await mkdtemp(join(tmpdir(), "u7agent-fake-proc-"));
  await mkdir(join(root, "net"));
  if (input.tcp) await writeFile(join(root, "net", "tcp"), [header, ...input.tcp].join("\n"));
  if (input.tcp6) await writeFile(join(root, "net", "tcp6"), [header, ...input.tcp6].join("\n"));
  for (const [pid, inodes] of Object.entries(input.fds ?? {})) {
    await mkdir(join(root, pid, "fd"), { recursive: true });
    for (const [index, inode] of inodes.entries())
      await symlink(`socket:[${inode}]`, join(root, pid, "fd", String(index + 3)));
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const PORT = 20001;
const HEX_PORT = "4E21";

test("待受の所有: LISTEN の inode が子の fd にあるときだけ yes", async () => {
  const listener = line(`0100007F:${HEX_PORT}`, "0A", 12345);
  const cases: Array<{ name: string; proc: Parameters<typeof fakeProc>[0]; pid: number; expected: string }> = [
    {
      name: "子の fd に、その待受の socket がある",
      proc: { tcp: [listener], fds: { 100: [999, 12345] } },
      pid: 100,
      expected: "yes",
    },
    {
      name: "IPv6 の ::1 だけの待受は、IPv4 の probe の繋ぎ先ではない",
      proc: { tcp: [], tcp6: [line(`00000000000000000000000001000000:${HEX_PORT}`, "0A", 777)], fds: { 100: [777] } },
      pid: 100,
      expected: "no",
    },
    {
      name: "同じアドレスとポートの LISTEN が 2 つある (繋ぎ先を決められない)",
      proc: { tcp: [listener, line(`0100007F:${HEX_PORT}`, "0A", 999)], fds: { 100: [999] } },
      pid: 100,
      expected: "no",
    },
    {
      name: "別のプロセスが待ち受けている (子の fd に無い)",
      proc: { tcp: [listener], fds: { 100: [999], 200: [12345] } },
      pid: 100,
      expected: "no",
    },
    {
      name: "そのポートの待受が無い",
      proc: { tcp: [line("0100007F:1F90", "0A", 5)], fds: { 100: [5] } },
      pid: 100,
      expected: "no",
    },
    {
      name: "LISTEN でない (接続済み) は数えない",
      proc: { tcp: [line(`0100007F:${HEX_PORT}`, "01", 12345)], fds: { 100: [12345] } },
      pid: 100,
      expected: "no",
    },
    { name: "子が居ない (fd の表が無い)", proc: { tcp: [listener], fds: {} }, pid: 100, expected: "no" },
    { name: "tcp の表が読めない (/proc が無い環境)", proc: { fds: { 100: [12345] } }, pid: 100, expected: "unknown" },
  ];
  for (const { name, proc, pid, expected } of cases) {
    const fake = await fakeProc(proc);
    try {
      assert.equal(await loopbackListenerOwner(pid, PORT, fake.root), expected, name);
    } finally {
      await fake.cleanup();
    }
  }
});

test("待受の所有: 実際の /proc で、自分が開いた待受は yes、待ち受けていないポートは no", LINUX_ONLY, async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(await loopbackListenerOwner(process.pid, address.port), "yes");
    const unused = address.port === 65535 ? 65534 : address.port + 1;
    assert.equal(await loopbackListenerOwner(process.pid, unused), "no");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
