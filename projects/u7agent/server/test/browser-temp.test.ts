// 呼び出しごとの一時領域と終了済み呼び出しの回収 (server/src/browser/temp.ts) を検証する。
// 生存中の呼び出しを消さないことと、PID 再利用を取り違えないことが契約 (回収は次回起動の掃除に寄せている)。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  callDirName,
  cleanupStaleCallDirs,
  createCallDirs,
  isCallOwnerAlive,
  parseCallDirName,
  type ProcessStartTimeReader,
} from "../src/browser/temp";

const STARTED_AT = 1_700_000_000_000;

function reader(entries: Record<number, number | undefined>): ProcessStartTimeReader {
  return async (pid) => entries[pid];
}

test("置き場の名前は所有者 (pid と起動時刻) を表す", () => {
  assert.equal(callDirName({ pid: 1234, startedAtMs: STARTED_AT }), `1234-${STARTED_AT}`);
  assert.deepEqual(parseCallDirName(`1234-${STARTED_AT}`), { pid: 1234, startedAtMs: STARTED_AT });
  for (const name of ["", "1234", "1234-", "-1234", "1234-abc", "0-1", "abc-1", "12-34-56", "1234-1.5"]) {
    assert.equal(parseCallDirName(name), undefined, name);
  }
});

test("生存判定は不明 (0) を生存として扱い、起動時刻の不一致を終了とみなす", async () => {
  const owner = { pid: 4321, startedAtMs: STARTED_AT };
  assert.equal(await isCallOwnerAlive(owner, reader({ 4321: STARTED_AT })), true);
  assert.equal(await isCallOwnerAlive(owner, reader({ 4321: undefined })), false, "プロセスが居ない");
  assert.equal(await isCallOwnerAlive(owner, reader({ 4321: STARTED_AT + 1 })), false, "PID が再利用された");
  assert.equal(await isCallOwnerAlive(owner, reader({ 4321: 0 })), true, "起動時刻を読めない");
});

test("掃除は終了済みと確認できる置き場だけを消し、他の名前は触らない", async () => {
  const root = await mkdtemp(join(tmpdir(), "u7agent-browser-temp-"));
  try {
    const alive = `111-${STARTED_AT}`;
    const dead = `222-${STARTED_AT}`;
    const reused = `333-${STARTED_AT}`;
    const unknown = `444-${STARTED_AT}`;
    const foreign = "not-a-call-dir";
    for (const name of [alive, dead, reused, unknown, foreign])
      await mkdir(join(root, name, "tmp"), { recursive: true });
    const removed = await cleanupStaleCallDirs({
      root,
      readStartedAt: reader({ 111: STARTED_AT, 222: undefined, 333: STARTED_AT + 1, 444: 0 }),
    });
    assert.deepEqual(removed.sort(), [dead, reused].sort());
    assert.deepEqual((await readdir(root)).sort(), [alive, foreign, unknown].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("掃除の失敗は警告に留め、呼び出し元の処理を止めない", async () => {
  const root = await mkdtemp(join(tmpdir(), "u7agent-browser-temp-"));
  try {
    await mkdir(join(root, "555-1", "tmp"), { recursive: true });
    const messages: string[] = [];
    const removed = await cleanupStaleCallDirs({
      root,
      readStartedAt: async () => {
        throw new Error("読めない");
      },
      log: (message) => messages.push(message),
    });
    assert.deepEqual(removed, []);
    assert.equal(messages.length, 1, "残した理由を出す");
    assert.deepEqual(await readdir(root), ["555-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("自分の置き場は生存として作られ、掃除の対象にならない", async () => {
  const root = await mkdtemp(join(tmpdir(), "u7agent-browser-temp-"));
  try {
    const dirs = await createCallDirs({ root });
    assert.ok(dirs.root.startsWith(join(root, `${process.pid}-`)), dirs.root);
    assert.deepEqual((await readdir(dirs.root)).sort(), ["home", "tmp"]);
    await writeFile(join(dirs.home, "cache.txt"), "x");
    assert.deepEqual(await cleanupStaleCallDirs({ root }), [], "生存中の pid を持つ置き場は消さない");
    assert.deepEqual((await readdir(dirs.root)).sort(), ["home", "tmp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
