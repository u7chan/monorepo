// GET / POST /v1/files/handoff。実ファイルシステムを使い、listen せず app.request() で検証する。
// 引き継ぎメモの上限・UTF-8・バイナリの判定、先頭追記、既存の中身の保持、本文ハッシュによる冪等化、
// 同一実パスへの並行追記がどちらも残ることを固定する。

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-sbx-handoff-${prefix}-`));
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function read(app: App, path: string): Promise<Response> | Response {
  return app.request(`/v1/files/handoff?path=${encodeURIComponent(path)}`, { headers: headers() });
}

function write(
  app: App,
  body: { path?: unknown; section?: unknown; dedupeKey?: unknown },
): Promise<Response> | Response {
  return app.request("/v1/files/handoff", { method: "POST", headers: headers(), body: JSON.stringify(body) });
}

function section(hash: string, text: string): string {
  return `# 引き継ぎメモ (本文ハッシュ: ${hash})\n\n${text}\n\nこの続きをお願いします。\n\n`;
}

function rollback(app: App, body: { path?: unknown; expected?: unknown }): Promise<Response> | Response {
  return app.request("/v1/files/handoff/rollback", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
}

test("prepends a section, keeps the existing body, and answers created/written", async () => {
  const root = makeRoot("prepend");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });

  const first = await write(app, { path: "work/HANDOFF.md", section: section("aaaa", "1 回目"), dedupeKey: "aaaa" });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { path: "work/HANDOFF.md", written: true, created: true });

  const second = await write(app, {
    path: "work/HANDOFF.md",
    section: section("bbbb", "2 回目"),
    dedupeKey: "bbbb",
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { path: "work/HANDOFF.md", written: true, created: false });
  const text = await readFile(join(root, "work/HANDOFF.md"), "utf8");
  assert.ok(text.startsWith("# 引き継ぎメモ (本文ハッシュ: bbbb)"), "新しい節が先頭に無い");
  assert.ok(text.endsWith("この続きをお願いします。\n\n"), "既存の本文が残っていない");
  assert.ok(text.includes("1 回目"), "既存の節が消えている");
});

test("skips the write when the first line already carries the same hash", async () => {
  const root = makeRoot("dedupe");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });
  const body = { path: "work/HANDOFF.md", section: section("cccc", "同じ材料"), dedupeKey: "cccc" };

  assert.equal((await write(app, body)).status, 200);
  const again = await write(app, body);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { path: "work/HANDOFF.md", written: false, created: false });
  const text = await readFile(join(root, "work/HANDOFF.md"), "utf8");
  assert.equal(text.split("# 引き継ぎメモ").length - 1, 1, "同じハッシュの節が二重になっている");
});

test("keeps both sections when two writes race on the same path", async () => {
  const root = makeRoot("race");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });

  const [a, b] = await Promise.all([
    write(app, { path: "work/HANDOFF.md", section: section("1111", "会話 A"), dedupeKey: "1111" }),
    write(app, { path: "work/HANDOFF.md", section: section("2222", "会話 B"), dedupeKey: "2222" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const text = await readFile(join(root, "work/HANDOFF.md"), "utf8");
  assert.ok(text.includes("会話 A"), "A のメモが消えている");
  assert.ok(text.includes("会話 B"), "B のメモが消えている");
  assert.equal(text.split("# 引き継ぎメモ").length - 1, 2, "片方のメモしか残っていない");
});

test("rejects an append that would push the file over the limit inside the lock", async () => {
  const root = makeRoot("limit");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });

  // 上限の直前まで埋める。事前判定 (BFF 側) はどちらの節も通るが、排他の中で読み直すと後着だけ超える
  const limit = 2 * 1024 * 1024;
  const sectionText = section("3333", "後着");
  await writeFile(join(root, "work", "HANDOFF.md"), "x".repeat(limit - 10));
  const [a, b] = await Promise.all([
    write(app, { path: "work/HANDOFF.md", section: "y".repeat(8), dedupeKey: "aaaa" }),
    write(app, { path: "work/HANDOFF.md", section: sectionText, dedupeKey: "3333" }),
  ]);
  // 先着は 200。すべてが上限内に収まる
  assert.equal(a.status, 200);
  assert.equal(b.status, 400);
  const size = (await readFile(join(root, "work", "HANDOFF.md"))).byteLength;
  assert.ok(size <= limit, `上限を超えて保存されている (${size} bytes)`);
});

test("deletes a memo only when it still matches, keeping another append", async () => {
  const root = makeRoot("rollback");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });

  // 新規作成した節は、そのままなら消える
  assert.equal(
    (await write(app, { path: "work/HANDOFF.md", section: section("4444", "A"), dedupeKey: "4444" })).status,
    200,
  );
  const created = await rollback(app, { path: "work/HANDOFF.md", expected: section("4444", "A") });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { deleted: true });
  assert.equal(await readFile(join(root, "work", "HANDOFF.md"), "utf8").catch(() => undefined), undefined);

  // 背後の追記が入ったら消さない (他の追記を巻き戻さない)
  await write(app, { path: "work/HANDOFF.md", section: section("5555", "A"), dedupeKey: "5555" });
  await write(app, { path: "work/HANDOFF.md", section: section("6666", "B"), dedupeKey: "6666" });
  const raced = await rollback(app, { path: "work/HANDOFF.md", expected: section("5555", "A") });
  assert.equal(raced.status, 200);
  assert.deepEqual(await raced.json(), { deleted: false });
  const text = await readFile(join(root, "work", "HANDOFF.md"), "utf8");
  assert.ok(text.includes("B"), "背後の追記が消えている");
  assert.ok(text.includes("A"), "自分の節まで消えている");
});

test("does not read or roll back through a symlink to an outside file", async () => {
  const root = makeRoot("read-symlink");
  const outside = makeRoot("read-outside");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(outside, "target.md"), "外のファイル");
  await symlink(join(outside, "target.md"), join(root, "work", "HANDOFF.md"));

  // 読取りも下準備も最終要素のリンクを拒む (書込み側と同じ契約)
  const readResponse = await read(app, "work/HANDOFF.md");
  assert.equal(readResponse.status, 400);
  assert.match(((await readResponse.json()) as { error: string }).error, /Symbolic links/);
  assert.equal((await rollback(app, { path: "work/HANDOFF.md", expected: "外のファイル" })).status, 400);
  assert.equal(await readFile(join(outside, "target.md"), "utf8"), "外のファイル", "root 外が変わっている");
});

test("reads the memo and answers 404 for a missing file", async () => {
  const root = makeRoot("read");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "work", "HANDOFF.md"), "# メモ\n");

  const found = await read(app, "work/HANDOFF.md");
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { text: "# メモ\n" });
  assert.equal((await read(app, "work/missing.md")).status, 404);
});

test("rejects a memo that is too large, not UTF-8, or binary before touching the file", async () => {
  const root = makeRoot("reject");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });

  // 2 MiB 超
  await writeFile(join(root, "work", "big.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  const big = await read(app, "work/big.md");
  assert.equal(big.status, 400);
  assert.match(((await big.json()) as { error: string }).error, /2 MiB/);

  // UTF-8 でない
  await writeFile(join(root, "work", "latin.md"), Buffer.from([0xff, 0xfe, 0x41]));
  assert.equal((await read(app, "work/latin.md")).status, 400);

  // バイナリ (制御文字)
  await writeFile(join(root, "work", "bin.md"), Buffer.from([0x41, 0x00, 0x42]));
  assert.equal((await read(app, "work/bin.md")).status, 400);

  // 上限を超える内容の書込みは、節の時点で 400 にする
  const tooLarge = await write(app, { path: "work/new.md", section: "a".repeat(2 * 1024 * 1024 + 1), dedupeKey: "x" });
  assert.equal(tooLarge.status, 400);
});

test("does not write through a symlink to an outside file", async () => {
  const root = makeRoot("symlink");
  const outside = makeRoot("outside");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(outside, "target.md"), "外のファイル");
  await symlink(join(outside, "target.md"), join(root, "work", "link.md"));

  const response = await write(app, {
    path: "work/link.md",
    section: section("dddd", "書かない"),
    dedupeKey: "dddd",
  });
  assert.equal(response.status, 400);
  assert.equal(await readFile(join(outside, "target.md"), "utf8"), "外のファイル", "root 外を書き換えている");
});

test("requires authentication and rejects a bad body", async () => {
  const root = makeRoot("auth");
  const { app } = createSandboxService({ rootCwd: root, token: TOKEN });
  assert.equal((await app.request("/v1/files/handoff?path=work/HANDOFF.md")).status, 401);
  assert.equal(
    (await app.request("/v1/files/handoff", { method: "POST", headers: headers(), body: "{}" })).status,
    400,
  );
});
