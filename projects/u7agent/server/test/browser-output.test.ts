// 成果物の保存 (server/src/browser/outputs.ts) を検証する。
// 上書きしないこと・返すのが実際の cwd 相対パスであることは、エージェントが返り値をそのまま `read` と
// Markdown に使う契約なので、候補名の進み方とバイト境界の切り詰めまでここで固定する。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capLines,
  outputCandidateNames,
  saveOutput,
  truncateToBytes,
  validateOutputName,
} from "../src/browser/outputs";

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-outputs-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("保存名は cwd 相対の .png だけを受け付ける", () => {
  assert.equal(validateOutputName("shot.png"), "shot.png");
  assert.equal(validateOutputName("shots/home-1.PNG"), "shots/home-1.PNG");
  for (const name of ["", "/abs.png", "../up.png", "./a.png", "shots//a.png", "a\\b.png", "a.jpg", "a"]) {
    assert.throws(() => validateOutputName(name), /保存|絶対|使えません|png/, name);
  }
});

test("保存名の候補は連番で進み、上限へ達したらランダム suffix になる", () => {
  const candidates = outputCandidateNames("shot.png");
  assert.equal(candidates.next().value, "shot.png");
  assert.equal(candidates.next().value, "shot-1.png");
  assert.equal(candidates.next().value, "shot-2.png");
  const nested = outputCandidateNames("dir/shot.png");
  for (let index = 0; index < 101; index += 1) nested.next();
  assert.match(String(nested.next().value), /^dir\/shot-[0-9a-f]{8}\.png$/);
});

test("同名があっても上書きせず、実際に保存した cwd 相対パスを返す", async () => {
  await withTempDir(async (dir) => {
    const first = await saveOutput(dir, "shots/home.png", Buffer.from("first"));
    assert.equal(first.path, "shots/home.png");
    assert.equal(first.absolutePath, join(dir, "shots", "home.png"));
    assert.equal(first.bytes, 5);

    const second = await saveOutput(dir, "shots/home.png", Buffer.from("second"));
    assert.equal(second.path, "shots/home-1.png");
    assert.equal(await readFile(first.absolutePath, "utf8"), "first");
    assert.equal(await readFile(second.absolutePath, "utf8"), "second");
  });
});

test("既にあるファイルは触らず、ディレクトリの作成だけを行う", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "kept.png"), "keep");
    const saved = await saveOutput(dir, "kept.png", Buffer.from("new"));
    assert.equal(saved.path, "kept-1.png");
    assert.equal(await readFile(join(dir, "kept.png"), "utf8"), "keep");
  });
});

test("バイト数の切り詰めは UTF-8 の途中で切らない", () => {
  assert.deepEqual(truncateToBytes("abc", 10), { text: "abc", truncated: false });
  assert.deepEqual(truncateToBytes("あいう", 9), { text: "あいう", truncated: false });
  const cut = truncateToBytes("あいう", 8);
  assert.deepEqual(cut, { text: "あい", truncated: true });
  assert.ok(!cut.text.includes("\uFFFD"));
  assert.equal(cut.text, "あい");
  assert.deepEqual(truncateToBytes("あいう", 1), { text: "", truncated: true });
});

test("出力の切り詰めは末尾の改行を含めて上限へ収め、要約行を残す", () => {
  const lines = ["l1", "l2", "l3"];
  // 全行が入るときは省略の通知を出さない
  assert.equal(capLines(lines, "summary", 1000), "l1\nl2\nl3\nsummary\n");
  assert.ok(Buffer.byteLength(capLines(lines, "summary", 1000), "utf8") <= 1000);

  // 通知を積むと超える場合は積まず、要約行だけは必ず残す
  const tight = capLines(lines, "summary", 12);
  assert.equal(tight, "l1\nsummary\n");
  assert.ok(Buffer.byteLength(tight, "utf8") <= 12, `${Buffer.byteLength(tight, "utf8")} bytes`);

  // 本文を落とし、通知が入る余地があれば通知を積む
  const noticed = capLines(["x".repeat(100), "y".repeat(200)], "s", 250);
  assert.ok(noticed.includes("出力の上限に達したため残りを省略しました"), noticed);
  assert.ok(!noticed.includes("y".repeat(200)), "入らない行は落とす");
  assert.ok(Buffer.byteLength(noticed, "utf8") <= 250, `${Buffer.byteLength(noticed, "utf8")} bytes`);
});

test("要約行だけでも上限を超えるときは、結論の先頭を残して切る", () => {
  const cut = capLines(["l1"], "summary", 5);
  assert.equal(cut, "s...\n", "要約の先頭と切った印だけを残す");
  assert.ok(Buffer.byteLength(cut, "utf8") <= 5);

  // 改行すら入らない予算では空を返す (それでも上限以下)
  assert.equal(capLines(["l1"], "summary", 1), "");
  assert.equal(capLines([], "summary", 0), "");
  assert.equal(capLines(["l1"], "s", 4), "s\n", "通知も本文も積めないときは要約だけを返す");
});
