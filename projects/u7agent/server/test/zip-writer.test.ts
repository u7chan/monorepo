// server/src/sandbox/zip.ts（ストリーミング ZIP ライタ）。`unzip` はホストにも CI にも無いため、
// test/zip-reader.ts の自前パーサで中央ディレクトリ・ローカルヘッダ・data descriptor を検証する。
// 実ファイルを読むので、一時ディレクトリに作って createZipStream へ渡す。

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, createZipStream, zipCompressionFor, type ZipEntry } from "../src/sandbox/zip";
import { parseZip } from "./zip-reader";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-zip-${prefix}-`));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** 名前 → 内容のファイルを作り、ZIP へ入れるエントリを返す */
function writeEntries(root: string, files: Record<string, string>): ZipEntry[] {
  return Object.entries(files).map(([name, content]) => {
    const source = join(root, name.replaceAll("/", "__"));
    writeFileSync(source, content);
    return { name, source, mtime: new Date("2024-05-06T07:08:10Z") };
  });
}

test("crc32 は既知のベクタと一致し、分割した入力でも継続できる", () => {
  const value = Buffer.from("123456789");
  assert.equal(crc32(value), 0xcbf43926);
  // 前回の戻り値を seed に渡すと、結合した入力と同じ値になる
  assert.equal(crc32(value.subarray(5), crc32(value.subarray(0, 5))), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("zipCompressionFor は既存の圧縮形式だけ store にする", () => {
  for (const name of ["a.png", "photo.JPG", "docs/report.pdf", "vendor/bundle.zip", "font.woff2", "song.mp3"]) {
    assert.equal(zipCompressionFor(name), "store", name);
  }
  for (const name of ["main.ts", "README", ".gitignore", "Makefile", "data.json", "a.tar"]) {
    assert.equal(zipCompressionFor(name), "deflate", name);
  }
});

test("ファイル / 空ファイル / 空ディレクトリ / 日本語名を書ける", async () => {
  const root = makeRoot("files");
  const entries: ZipEntry[] = [
    ...writeEntries(root, {
      "hello.txt": "hello zip",
      "zero.txt": "",
      "image.png": "not really a png",
      "日本語 名前.txt": "こんにちは",
    }),
    // ディレクトリは末尾 `/` のエントリだけ（内容は持たない）
    { name: "empty/", mtime: new Date("2024-05-06T07:08:10Z") },
  ];
  const parsed = parseZip(await collect(createZipStream(entries)));
  assert.deepEqual(
    parsed.map((entry) => entry.name),
    ["hello.txt", "zero.txt", "image.png", "日本語 名前.txt", "empty/"],
  );

  const byName = new Map(parsed.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("hello.txt")?.data.toString("utf8"), "hello zip");
  assert.equal(byName.get("zero.txt")?.data.length, 0);
  assert.equal(byName.get("日本語 名前.txt")?.data.toString("utf8"), "こんにちは");
  assert.equal(byName.get("empty/")?.size, 0);
  assert.equal(byName.get("empty/")?.data.length, 0);

  // 拡張子で store / deflate を選ぶ
  assert.equal(byName.get("image.png")?.method, 0);
  assert.equal(byName.get("hello.txt")?.method, 8);

  for (const entry of parsed) {
    assert.equal(entry.localFlags, entry.flags, `${entry.name}: ローカルと中央で flags が違う`);
    assert.ok(entry.descriptorMatches, `${entry.name}: data descriptor が中央ディレクトリと一致しない`);
    assert.ok(entry.crcMatches, `${entry.name}: CRC またはサイズが本文と一致しない`);
    // bit 3 (data descriptor) と bit 11 (UTF-8 名) を立てる
    assert.equal(entry.flags & 0x0008, 0x0008, `${entry.name}: data descriptor の bit が無い`);
    assert.equal(entry.flags & 0x0800, 0x0800, `${entry.name}: UTF-8 の bit が無い`);
  }
});

test("64 KiB を超えるファイルも分割してストリームできる", async () => {
  const root = makeRoot("stream");
  // 圧縮が効かないバイト列にして、複数チャンクの deflate とサイズ計算を通す
  const content = Buffer.alloc(200 * 1024);
  for (let index = 0; index < content.length; index += 1) content[index] = (index * 31) % 251;
  const source = join(root, "blob.bin");
  writeFileSync(source, content);

  const parsed = parseZip(await collect(createZipStream([{ name: "blob.bin", source }])));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].size, content.length);
  assert.ok(parsed[0].data.equals(content), "本文が元のバイト列と一致しない");
  assert.ok(parsed[0].crcMatches, "複数チャンクの CRC が壊れている");
  assert.ok(parsed[0].compressedSize > 0);
});

test("空のエントリ一覧でも読めるアーカイブになる", async () => {
  const archive = await collect(createZipStream([]));
  assert.deepEqual(parseZip(archive), []);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

test("存在しないファイルはストリームの途中で失敗する（壊れた zip を成功にしない）", async () => {
  const root = makeRoot("missing");
  const entries: ZipEntry[] = [
    ...writeEntries(root, { "ok.txt": "ok" }),
    { name: "gone.txt", source: join(root, "does-not-exist.txt") },
  ];
  await assert.rejects(collect(createZipStream(entries)));
});
