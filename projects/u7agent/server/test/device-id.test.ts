// OAuth サインインの agent host ID (device id) の永続化。実 SDK は呼ばず、テンポラリのファイルだけで検証する。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeviceIdStore, DEVICE_ID_PATH } from "../src/device-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-device-id-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("最初の取得で UUID を作って保存し、作った store では同じ値を返す", async () => {
  await withDir(async (dir) => {
    const path = join(dir, DEVICE_ID_PATH);
    const store = createDeviceIdStore(path);
    const created = store.getOrCreate();
    assert.match(created, UUID_PATTERN);
    assert.equal(store.getOrCreate(), created, "同じプロセスでは同じ値");
    assert.equal((await readFile(path, "utf8")).trim(), created);
  });
});

test("プロセスを作り直しても保存済みの値を返す", async () => {
  await withDir(async (dir) => {
    const path = join(dir, DEVICE_ID_PATH);
    const first = createDeviceIdStore(path).getOrCreate();
    const second = createDeviceIdStore(path).getOrCreate();
    assert.equal(second, first, "再起動しても同じ agent host ID を使う");
  });
});

test("壊れた値は作り直して上書きする", async () => {
  await withDir(async (dir) => {
    const path = join(dir, DEVICE_ID_PATH);
    await mkdir(join(dir, "u7agent"), { recursive: true });
    await writeFile(path, "not-a-uuid\n");
    const logs: string[] = [];
    const store = createDeviceIdStore(path, (message) => logs.push(message));
    const created = store.getOrCreate();
    assert.match(created, UUID_PATTERN);
    assert.equal((await readFile(path, "utf8")).trim(), created);
    // 次回の起動は作り直した値を使う
    assert.equal(createDeviceIdStore(path).getOrCreate(), created);
    assert.equal(logs.length, 1, "作り直した理由をログへ残す");
  });
});

test("書けない場所でも値を返し、プロセス内では同じ値を返し続ける", async () => {
  await withDir(async (dir) => {
    // 親が通常ファイルなので mkdir が ENOTDIR で失敗する (権限に依存しない再現)
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "");
    const logs: string[] = [];
    const store = createDeviceIdStore(join(blocker, "u7agent", "device-id"), (message) => logs.push(message));
    const created = store.getOrCreate();
    assert.match(created, UUID_PATTERN, "保存できなくてもログインは続けられる");
    assert.equal(store.getOrCreate(), created);
    assert.ok(
      logs.some((message) => message.startsWith("device id write failed")),
      "書けなかったことをログへ残す",
    );
  });
});
