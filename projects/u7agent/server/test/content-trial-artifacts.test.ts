// 試行の成果物の置き場（形式の許可リスト・ファイル名の固定・読み書き・削除）。実 API も実 DB も使わない。
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTrialArtifactStore,
  isTrialId,
  prepareTrialImageArtifact,
  prepareTrialSpeechArtifact,
  TRIAL_ARTIFACT_MAX_BYTES,
  trialArtifactContentType,
  trialArtifactFileName,
  trialArtifactFormatAllowed,
  trialArtifactFormatOf,
  trialArtifactIdOfFileName,
} from "../src/content-trial-artifacts";

const TRIAL_ID = "trial-0123456789abcdef01234567";

function pngBytes(width = 640, height = 480): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegBytes(width = 320, height = 200): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
}

function webpBytes(width = 100, height = 50): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([...Buffer.from("RIFF")], 0);
  bytes.set([...Buffer.from("WEBP")], 8);
  bytes.set([...Buffer.from("VP8L")], 12);
  bytes[20] = 0x2f;
  // 14bit 幅 / 14bit 高さ（それぞれ -1 で格納）
  const bits = (width - 1) | ((height - 1) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >> 8) & 0xff;
  bytes[23] = (bits >> 16) & 0xff;
  return bytes;
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

test("許可リストの形式（png / jpeg / webp）だけを保存できる形にし、実バイトから寸法を読む", () => {
  const png = prepareTrialImageArtifact({ mimeType: "image/png", data: base64(pngBytes(640, 480)) });
  assert.equal(png.ok, true);
  if (!png.ok) return;
  assert.equal(png.format, "png");
  assert.equal(png.width, 640);
  assert.equal(png.height, 480);

  const jpeg = prepareTrialImageArtifact({ mimeType: "image/jpeg", data: base64(jpegBytes(320, 200)) });
  assert.equal(jpeg.ok && jpeg.format, "jpeg");

  const webp = prepareTrialImageArtifact({ mimeType: "image/webp", data: base64(webpBytes(100, 50)) });
  assert.equal(webp.ok, true);
  if (!webp.ok) return;
  assert.equal(webp.format, "webp");
  assert.equal(webp.width, 100);
  assert.equal(webp.height, 50);
});

test("svg / html / 不明な MIME は保存の前に拒否する", () => {
  const svg = base64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  for (const mimeType of ["image/svg+xml", "text/html", "application/octet-stream", ""]) {
    assert.deepEqual(prepareTrialImageArtifact({ mimeType, data: svg }), { ok: false, reason: "unsupported_format" });
  }
  // 宣言だけ許可リストでも、実バイトが画像でなければ保存しない
  assert.deepEqual(prepareTrialImageArtifact({ mimeType: "image/png", data: svg }), {
    ok: false,
    reason: "unsupported_format",
  });
});

test("壊れた base64 と上限を超えるバイト数は保存しない", () => {
  assert.deepEqual(prepareTrialImageArtifact({ mimeType: "image/png", data: "" }), {
    ok: false,
    reason: "invalid_bytes",
  });
  assert.deepEqual(prepareTrialImageArtifact({ mimeType: "image/png", data: "%%%" }), {
    ok: false,
    reason: "invalid_bytes",
  });
  const large = new Uint8Array(TRIAL_ARTIFACT_MAX_BYTES + 1);
  large.set(pngBytes(), 0);
  assert.deepEqual(prepareTrialImageArtifact({ mimeType: "image/png", data: base64(large) }), {
    ok: false,
    reason: "too_large",
  });
});

test("ファイル名は trial id と形式からだけ作り、id の形を外れる値は受け付けない", () => {
  assert.equal(trialArtifactFileName(TRIAL_ID, "png"), `${TRIAL_ID}.png`);
  assert.equal(trialArtifactFileName(TRIAL_ID, "jpeg"), `${TRIAL_ID}.jpg`);
  assert.equal(trialArtifactFileName(TRIAL_ID, "webp"), `${TRIAL_ID}.webp`);
  assert.equal(trialArtifactContentType("jpeg"), "image/jpeg");
  assert.throws(() => trialArtifactFileName("../../etc/passwd", "png"), /不正/);
  assert.equal(isTrialId(TRIAL_ID), true);
  assert.equal(isTrialId("trial-1"), false);
  assert.equal(trialArtifactIdOfFileName(`${TRIAL_ID}.png`), TRIAL_ID);
  assert.equal(trialArtifactIdOfFileName("note.png"), undefined);
  assert.equal(trialArtifactIdOfFileName("../trial-0123456789abcdef01234567.png"), undefined);
  assert.equal(trialArtifactFormatOf("svg"), undefined);
  assert.equal(trialArtifactFileName(TRIAL_ID, "mp3"), `${TRIAL_ID}.mp3`);
  assert.equal(trialArtifactContentType("mp3"), "audio/mpeg");
  assert.equal(trialArtifactContentType("wav"), "audio/wav");
  // 種別ごとの許可リストを混ぜない
  assert.equal(trialArtifactFormatAllowed("image", "png"), true);
  assert.equal(trialArtifactFormatAllowed("image", "mp3"), false);
  assert.equal(trialArtifactFormatAllowed("speech", "wav"), true);
  assert.equal(trialArtifactFormatAllowed("speech", "png"), false);
  assert.equal(trialArtifactFormatAllowed("bgm", "mp3"), false);
});

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-trial-artifacts-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("置き場は `<trialId>.<ext>` だけを読み書きし、消した後は undefined になる", async () => {
  await withDir(async (dir) => {
    const store = createTrialArtifactStore(join(dir, "trials"));
    // 置き場が無い間は空（起動直後の再照合で落ちない）
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.read(`${TRIAL_ID}.png`), undefined);

    const bytes = pngBytes(64, 32);
    await store.write({ trialId: TRIAL_ID, format: "png", bytes });
    assert.deepEqual(await store.list(), [`${TRIAL_ID}.png`]);
    const read = await store.read(`${TRIAL_ID}.png`);
    assert.ok(read);
    assert.deepEqual(new Uint8Array(read), bytes);

    await store.remove(`${TRIAL_ID}.png`);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.read(`${TRIAL_ID}.png`), undefined);
    // 冪等（2 回目も成功する）
    await store.remove(`${TRIAL_ID}.png`);
  });
});

test("置き場は保存名の形を外れる要求を fs へ渡さず、未知のファイルは一覧に載せない", async () => {
  await withDir(async (dir) => {
    const root = join(dir, "trials");
    const store = createTrialArtifactStore(root);
    await store.write({ trialId: TRIAL_ID, format: "webp", bytes: webpBytes() });
    await writeFile(join(root, "keep.txt"), "not an artifact");
    assert.deepEqual(await store.list(), [`${TRIAL_ID}.webp`]);

    await assert.rejects(() => store.read("../escape.png"), /不正/);
    await assert.rejects(() => store.remove("/etc/passwd"), /不正/);
    await assert.rejects(() => store.read("keep.txt"), /不正/);
    // 置き場の外には書かない
    assert.deepEqual((await readdir(dir)).sort(), ["trials"]);
  });
});

test("音声は mp3 と wav だけを保存できる形にし、宣言 MIME と実バイトの両方を見る", () => {
  // mp3 は ID3 かフレーム同期で判定する。宣言 MIME が audio/mpeg であることも確かめる
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const mp3 = prepareTrialSpeechArtifact({ audio: id3.buffer, format: "mp3", contentType: "audio/mpeg" });
  assert.equal(mp3.ok, true);
  assert.equal(mp3.ok ? mp3.format : "", "mp3");
  assert.equal(mp3.ok ? mp3.bytes.byteLength : 0, 6);
  const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  assert.equal(prepareTrialSpeechArtifact({ audio: frame.buffer, format: "mp3", contentType: "audio/mpeg" }).ok, true);

  // 宣言と実バイトが食い違う / 宣言が許可外 / 中身が音声でない応答は保存しない
  assert.deepEqual(prepareTrialSpeechArtifact({ audio: id3.buffer, format: "mp3", contentType: "audio/pcm" }), {
    ok: false,
    reason: "unsupported_format",
  });
  assert.deepEqual(
    prepareTrialSpeechArtifact({ audio: new Uint8Array([1, 2, 3]).buffer, format: "mp3", contentType: "audio/mpeg" }),
    { ok: false, reason: "invalid_bytes" },
  );
  assert.deepEqual(
    prepareTrialSpeechArtifact({ audio: new Uint8Array(0).buffer, format: "mp3", contentType: "audio/mpeg" }),
    { ok: false, reason: "invalid_bytes" },
  );
  assert.deepEqual(
    prepareTrialSpeechArtifact({
      audio: new Uint8Array([1, 2]).buffer,
      format: "pcm",
      contentType: "audio/pcm",
      sampleRate: 24_000,
      channels: 1,
    }).ok,
    true,
    "pcm は RIFF 化して wav として保存できる",
  );

  // 上限を超える音声は保存しない
  const large = new Uint8Array(TRIAL_ARTIFACT_MAX_BYTES + 1);
  large.set(id3, 0);
  assert.deepEqual(prepareTrialSpeechArtifact({ audio: large.buffer, format: "mp3", contentType: "audio/mpeg" }), {
    ok: false,
    reason: "too_large",
  });
});
