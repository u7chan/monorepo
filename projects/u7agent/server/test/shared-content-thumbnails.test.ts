// 共有物のサムネイル。PNG の構造検証、保存・配信・削除の HTTP 契約、行と実体の再照合を検証する。
// 画像はすべてこのファイルで組み立てた架空の PNG で、実在の画像は使わない。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { createBffApp } from "../src/app";
import {
  SHARED_THUMBNAIL_DIR_NAME,
  SHARED_THUMBNAIL_MAX_BYTES,
  inspectSharedThumbnailPng,
} from "../src/shared-thumbnails";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** PNG のチャンク。type は 4 文字、crc を差し替えると破損を作れる */
function chunk(type: string, body: Uint8Array, crcOverride?: number): Uint8Array {
  const typed = new Uint8Array([...type].map((char) => char.charCodeAt(0)));
  const crcBody = concat([typed, body]);
  return concat([u32(body.byteLength), typed, body, u32(crcOverride ?? crc32(crcBody))]);
}

interface PngOptions {
  width: number;
  height: number;
  colorType?: number;
  bitDepth?: number;
  interlace?: number;
  /** 前後に足すチャンク（メタデータの混入を作る） */
  extra?: readonly Uint8Array[];
  /** 実際のデータは宣言より小さく作る（寸法とデータの食い違い） */
  shrinkData?: boolean;
  /** 末尾に足す不正なバイト（IEND 後の余剰） */
  trailing?: number;
  /** IHDR の CRC を壊す */
  corrupt?: boolean;
}

function png(options: PngOptions): Uint8Array {
  const { width, height, colorType = 6, bitDepth = 8, interlace = 0 } = options;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 4;
  const dataWidth = width * channels;
  const rows = options.shrinkData ? height - 1 : height;
  const raw = new Uint8Array(rows * (1 + dataWidth));
  for (let row = 0; row < rows; row += 1) {
    raw[row * (1 + dataWidth)] = 0;
    for (let column = 0; column < dataWidth; column += 1) {
      raw[row * (1 + dataWidth) + 1 + column] = (row + column) % 256;
    }
  }
  const header = concat([u32(width), u32(height), new Uint8Array([bitDepth, colorType, 0, 0, interlace])]);
  return concat([
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", header, options.corrupt ? 0 : undefined),
    ...(options.extra ?? []),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
    ...(options.trailing === undefined ? [] : [new Uint8Array(options.trailing)]),
  ]);
}

function textChunk(keyword: string, value: string): Uint8Array {
  const body = new Uint8Array([...keyword].map((char) => char.charCodeAt(0)).concat([0]));
  return chunk("tEXt", concat([body, new Uint8Array([...value].map((char) => char.charCodeAt(0)))]));
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-shared-thumb-"));
  const bff = await createBffApp({ cwd: "/workspace", sessionStoreDir: dir, pi: null, workspace: null });
  const seed = (id: string) =>
    bff.appDb.insertSharedContent({
      id,
      sessionId: "0123456789",
      name: id,
      sourcePath: "projects/app/dist",
      sourceKind: "directory",
      provider: "cloudflare",
      providerAccount: null,
      remoteId: null,
      publicUrl: null,
      status: "published",
      createdAt: 1,
      updatedAt: 1,
      publishedAt: 2,
      stoppedAt: null,
      lastError: null,
    });
  return {
    bff,
    dir,
    seed,
    restore: async () => {
      await bff.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const put = (body: Uint8Array | string, contentType = "image/png"): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": contentType },
  body: body as Uint8Array,
});

test("canvas 相当の PNG を寸法つきで受け、16:10・幅の範囲・形式の違いを拒否する", () => {
  assert.deepEqual(inspectSharedThumbnailPng(png({ width: 800, height: 500 })), { width: 800, height: 500 });
  assert.deepEqual(inspectSharedThumbnailPng(png({ width: 320, height: 200, colorType: 2 })), {
    width: 320,
    height: 200,
  });
  assert.deepEqual(inspectSharedThumbnailPng(png({ width: 1600, height: 1000, colorType: 0 })), {
    width: 1600,
    height: 1000,
  });

  // 16:10 でない / 幅の範囲外
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 600 })), undefined);
  assert.equal(inspectSharedThumbnailPng(png({ width: 1608, height: 1005 })), undefined);
  assert.equal(inspectSharedThumbnailPng(png({ width: 312, height: 195 })), undefined);
  // 16 bit / インターレースは canvas.toBlob の出力ではない
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 500, bitDepth: 16 })), undefined);
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 500, interlace: 1 })), undefined);
  // 未知の色種別
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 500, colorType: 5 })), undefined);
});

test("壊れた PNG（切断・CRC・余剰バイト・寸法とデータの食い違い）を拒否する", () => {
  const valid = png({ width: 800, height: 500 });
  assert.ok(inspectSharedThumbnailPng(valid));
  for (const cut of [8, 20, 40, valid.byteLength - 1]) {
    assert.equal(inspectSharedThumbnailPng(valid.subarray(0, cut)), undefined, `切断 ${cut}`);
  }
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 500, corrupt: true })), undefined);
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 500, trailing: 4 })), undefined);
  assert.equal(inspectSharedThumbnailPng(png({ width: 800, height: 500, shrinkData: true })), undefined);
  assert.equal(inspectSharedThumbnailPng(new Uint8Array(0)), undefined);
  assert.equal(inspectSharedThumbnailPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), undefined);
});

test("メタデータ付きの PNG は通さない（再描画で落ちるはずの情報を持ち込ませない）", () => {
  const withText = png({ width: 800, height: 500, extra: [textChunk("Comment", "secret")] });
  assert.equal(inspectSharedThumbnailPng(withText), undefined);
});

test("保存すると一覧と詳細にメタが載り、GET で同じ PNG を配信する", async () => {
  const { bff, seed, restore } = await setup();
  try {
    seed("thumb1");
    const bytes = png({ width: 800, height: 500 });
    const saved = await bff.app.request("/api/shared-contents/thumb1/thumbnail", put(bytes));
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as any;
    assert.equal(savedBody.thumbnail.width, 800);
    assert.equal(savedBody.thumbnail.height, 500);
    assert.equal(savedBody.thumbnail.bytes, bytes.byteLength);

    const detail = (await (await bff.app.request("/api/shared-contents/thumb1")).json()) as any;
    assert.deepEqual(detail.thumbnail, savedBody.thumbnail);
    const list = (await (await bff.app.request("/api/shared-contents")).json()) as any;
    assert.deepEqual(list.items[0].thumbnail, savedBody.thumbnail);
    // 未設定の行は null で、フィールド自体は必ず載る
    seed("thumb2");
    const list2 = (await (await bff.app.request("/api/shared-contents")).json()) as any;
    assert.equal(list2.items.find((item: any) => item.id === "thumb2").thumbnail, null);

    const served = await bff.app.request("/api/shared-contents/thumb1/thumbnail");
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("cache-control") ?? "", /immutable/);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), bytes);

    // 差し替えると版が進み、配信も新しい実体になる
    const next = png({ width: 640, height: 400 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const replaced = (await (await bff.app.request("/api/shared-contents/thumb1/thumbnail", put(next))).json()) as any;
    assert.ok(replaced.thumbnail.updatedAt >= savedBody.thumbnail.updatedAt);
    assert.equal(replaced.thumbnail.width, 640);
    assert.deepEqual(
      new Uint8Array(await (await bff.app.request("/api/shared-contents/thumb1/thumbnail")).arrayBuffer()),
      next,
    );
  } finally {
    await restore();
  }
});

test("受け入れの失敗は固定文言と状態を返し、行と実体を変えない", async () => {
  const { bff, seed, dir, restore } = await setup();
  try {
    seed("thumb1");
    const bytes = png({ width: 800, height: 500 });

    const wrongType = await bff.app.request("/api/shared-contents/thumb1/thumbnail", put(bytes, "image/jpeg"));
    assert.equal(wrongType.status, 415);
    assert.equal(((await wrongType.json()) as any).state, "not_stored");

    const broken = await bff.app.request(
      "/api/shared-contents/thumb1/thumbnail",
      put(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])),
    );
    assert.equal(broken.status, 422);
    assert.equal(((await broken.json()) as any).state, "not_stored");

    const unknown = await bff.app.request("/api/shared-contents/nope/thumbnail", put(bytes));
    assert.equal(unknown.status, 404);

    const oversized = await bff.app.request(
      "/api/shared-contents/thumb1/thumbnail",
      put(new Uint8Array(SHARED_THUMBNAIL_MAX_BYTES + 1)),
    );
    assert.equal(oversized.status, 413);

    const detail = (await (await bff.app.request("/api/shared-contents/thumb1")).json()) as any;
    assert.equal(detail.thumbnail, null, "失敗した要求でメタは入らない");
    await assert.rejects(() => readFile(join(dir, SHARED_THUMBNAIL_DIR_NAME, "thumb1.png")));
  } finally {
    await restore();
  }
});

test("サムネイルだけを外せる。未設定でも 204 で、共有物の行は残る", async () => {
  const { bff, seed, dir, restore } = await setup();
  try {
    seed("thumb1");
    const bytes = png({ width: 800, height: 500 });
    await bff.app.request("/api/shared-contents/thumb1/thumbnail", put(bytes));

    const removed = await bff.app.request("/api/shared-contents/thumb1/thumbnail", { method: "DELETE" });
    assert.equal(removed.status, 204);
    const again = await bff.app.request("/api/shared-contents/thumb1/thumbnail", { method: "DELETE" });
    assert.equal(again.status, 204, "2 回目も成功（結果不明の再試行で 404 にしない）");

    assert.equal((await bff.app.request("/api/shared-contents/thumb1/thumbnail")).status, 404);
    const detail = (await (await bff.app.request("/api/shared-contents/thumb1")).json()) as any;
    assert.equal(detail.thumbnail, null);
    await assert.rejects(() => readFile(join(dir, SHARED_THUMBNAIL_DIR_NAME, "thumb1.png")));
    assert.equal((await bff.app.request("/api/shared-contents/nope/thumbnail", { method: "DELETE" })).status, 404);
  } finally {
    await restore();
  }
});

test("共有物を削除するとサムネイルの実体も残さない", async () => {
  const { bff, seed, dir, restore } = await setup();
  try {
    seed("thumb1");
    await bff.app.request("/api/shared-contents/thumb1/thumbnail", put(png({ width: 800, height: 500 })));
    // provider 側の削除は行が未受付 (remoteId が null) なので走らない
    assert.equal((await bff.app.request("/api/shared-contents/thumb1", { method: "DELETE" })).status, 204);
    await assert.rejects(() => readFile(join(dir, SHARED_THUMBNAIL_DIR_NAME, "thumb1.png")));
  } finally {
    await restore();
  }
});

test("起動時の再照合で、行の無いファイルを消し、実体の無い行を未設定へ倒す", async () => {
  const { bff, seed, dir, restore } = await setup();
  try {
    const thumbnailDir = join(dir, SHARED_THUMBNAIL_DIR_NAME);
    await mkdir(thumbnailDir, { recursive: true });
    // 行が無いファイル
    await writeFile(join(thumbnailDir, "orphan.png"), png({ width: 800, height: 500 }));
    // 実体が無い行
    seed("ghost");
    bff.appDb.updateSharedContentThumbnail("ghost", { updatedAt: 5, width: 800, height: 500, bytes: 10 });

    await bff.sharedContents.reconcileThumbnails();

    await assert.rejects(() => readFile(join(thumbnailDir, "orphan.png")));
    assert.equal(bff.appDb.getSharedContent("ghost")?.thumbnail, null);
    assert.equal((await bff.app.request("/api/shared-contents/ghost/thumbnail")).status, 404);
  } finally {
    await restore();
  }
});
