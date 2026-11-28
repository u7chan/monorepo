// 起動ごとの flock (server/src/file-lock.ts) を検証する。実プロセスは起こさず、同じプロセスで開き直して見る。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFileLock, fileLockHeld } from "../src/file-lock";

test("ロックを持っているあいだは held、解放すると free、ファイルが無ければ unknown", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-file-lock-"));
  const path = join(base, "launch.lock");
  try {
    assert.equal(await fileLockHeld(path), "unknown", "ファイルが無いだけでは外れたと言わない");

    const lock = await acquireFileLock(path);
    assert.ok(lock, "ロックを取れる");
    assert.equal(await fileLockHeld(path), "held");

    lock.release();
    assert.equal(await fileLockHeld(path), "free");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("同じファイルのロックは二重に取れない", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-file-lock-"));
  const path = join(base, "launch.lock");
  try {
    const first = await acquireFileLock(path);
    assert.ok(first);
    assert.equal(await acquireFileLock(path), undefined);
    first.release();
    const second = await acquireFileLock(path);
    assert.ok(second, "解放後は取れる");
    second.release();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
