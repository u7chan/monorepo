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

test("出力の切り詰めは要約行を必ず残す", () => {
  const lines = ["l1", "l2", "l3"];
  assert.equal(capLines(lines, "summary", 1000), "l1\nl2\nl3\nsummary");
  const capped = capLines(lines, "summary", 20);
  assert.ok(capped.endsWith("summary"), capped);
  assert.ok(capped.includes("省略しました"), capped);
  assert.ok(!capped.includes("l3"), capped);
});
