// 参照画像の入力パス解決と実バイト判定。実ファイルも API も使わず、純関数と固定バイトだけを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { sessionUploadsRel } from "../src/app-paths";
import {
  IMAGE_INPUT_MAX_BYTES,
  inspectImageInput,
  leaksImageInputData,
  stripImageInputData,
} from "../src/image-format";
import {
  imageInputReferenceOf,
  imageInputScopeOf,
  resolveImageInputPath,
  type ImageInputContext,
} from "../src/image-input";

const ROOT = "/workspace";
const UPLOADS = ".u7agent/uploads/0123456789";

/** IHDR だけを持つ PNG。幅・高さは IHDR に入れる */
function pngBytes(width = 2, height = 2): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

/** SOI + SOF0 だけを持つ JPEG（高さ 2 / 幅 3） */
function jpegBytes(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01,
    0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

/** VP8X の WebP（幅 4 / 高さ 5） */
function webpBytes(width = 4, height = 5): Uint8Array {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(bytes);
}

function contextOf(overrides: Partial<ImageInputContext> = {}): ImageInputContext {
  return { sessionCwd: "projects/app", rootCwd: ROOT, uploadsDirRel: UPLOADS, ...overrides };
}

test("実バイトで PNG / JPEG / WebP を識別し、大きさを読む", () => {
  assert.deepEqual(inspectImageInput(pngBytes(640, 480)), { mimeType: "image/png", width: 640, height: 480 });
  assert.deepEqual(inspectImageInput(jpegBytes()), { mimeType: "image/jpeg", width: 3, height: 2 });
  assert.deepEqual(inspectImageInput(webpBytes()), { mimeType: "image/webp", width: 4, height: 5 });
});

test("対応外・壊れたヘッダは画像として扱わない", () => {
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(Buffer.from("<svg xmlns=</svg>")),
    new Uint8Array(Buffer.from("GIF89a")),
    // 署名だけの PNG / IHDR が壊れた PNG
    pngBytes().subarray(0, 12),
    new Uint8Array(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 99, 0x49, 0x48, 0x44, 0x52])),
    // SOF を持たない JPEG
    new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    // WEBP だがチャンクが未知
    new Uint8Array(Buffer.from("RIFF\x16\x00\x00\x00WEBPXXXX\x0a\x00\x00\x00")),
  ]) {
    assert.equal(inspectImageInput(bytes), undefined);
  }
  // 幅 0 は画像として扱わない
  assert.equal(inspectImageInput(pngBytes(0, 10)), undefined);
});

test("cwd 相対を root 相対へ直し、結果には cwd 相対を載せる", () => {
  assert.deepEqual(resolveImageInputPath("generated/portrait.png", contextOf()), {
    rootRelative: "projects/app/generated/portrait.png",
    display: "generated/portrait.png",
  });
  assert.deepEqual(resolveImageInputPath("./assets/./a.webp", contextOf()), {
    rootRelative: "projects/app/assets/a.webp",
    display: "assets/a.webp",
  });
  // 未所属セッション (cwd = root) は前置しない
  assert.deepEqual(resolveImageInputPath("generated/a.png", contextOf({ sessionCwd: "" })), {
    rootRelative: "generated/a.png",
    display: "generated/a.png",
  });
});

test("cwd / 添付置き場の配下を指す絶対パスだけを受け付ける", () => {
  assert.deepEqual(resolveImageInputPath(`${ROOT}/projects/app/generated/a.png`, contextOf()), {
    rootRelative: "projects/app/generated/a.png",
    display: "generated/a.png",
  });
  assert.deepEqual(resolveImageInputPath(`${ROOT}/${UPLOADS}/photo.png`, contextOf()), {
    rootRelative: `${UPLOADS}/photo.png`,
    display: `${UPLOADS}/photo.png`,
  });
  // 追加スペースは添付置き場が変わる（保存先は app-paths.ts の sessionUploadsRel が正）
  const spaceUploads = sessionUploadsRel("0123456789", "space-0123456789abcdef");
  assert.deepEqual(
    resolveImageInputPath(`${ROOT}/${spaceUploads}/photo.png`, contextOf({ uploadsDirRel: spaceUploads })),
    { rootRelative: `${spaceUploads}/photo.png`, display: `${spaceUploads}/photo.png` },
  );
  // 添付置き場が未確定なら絶対パスの添付は許可しない
  assert.throws(
    () => resolveImageInputPath(`${ROOT}/${UPLOADS}/photo.png`, contextOf({ uploadsDirRel: undefined })),
    /現在の作業フォルダかこの会話の添付/,
  );
});

test("範囲外・URL・data URL・`..`・バックスラッシュは拒む", () => {
  const cases: [string, RegExp][] = [
    ["", /パスが空です/],
    ["   ", /パスが空です/],
    ["../secret.png", /作業フォルダの外/],
    ["generated/../../secret.png", /作業フォルダの外/],
    ["/etc/passwd", /作業フォルダの外/],
    [`${ROOT}/projects/other/a.png`, /現在の作業フォルダかこの会話の添付/],
    [`${ROOT}/.u7agent/uploads/ffffffffffff/photo.png`, /現在の作業フォルダかこの会話の添付/],
    ["generated\\a.png", /バックスラッシュ/],
    ["https://example.invalid/a.png", /ローカル画像のパスだけ/],
    ["data:image/png;base64,AAAA", /ローカル画像のパスだけ/],
    ["C:/images/a.png", /ローカル画像のパスだけ/],
    ["generated/", /ファイル名まで指定/],
  ];
  for (const [path, pattern] of cases) assert.throws(() => resolveImageInputPath(path, contextOf()), pattern, path);
});

test("許可範囲は cwd と添付置き場だけで、root 全体を渡さない", () => {
  assert.deepEqual(imageInputScopeOf(contextOf()), ["projects/app", UPLOADS]);
  assert.deepEqual(imageInputScopeOf(contextOf({ sessionCwd: "" })), ["", UPLOADS]);
  assert.deepEqual(imageInputScopeOf(contextOf({ uploadsDirRel: undefined })), ["projects/app"]);
  // cwd が root で添付置き場が未確定なら root だけ
  assert.deepEqual(imageInputScopeOf(contextOf({ sessionCwd: "", uploadsDirRel: undefined })), [""]);
});

test("data URL 化は実バイトの形式を使い、空・対応外・上限超過を拒む", () => {
  const target = { rootRelative: "generated/a.png", display: "generated/a.png" };
  const png = pngBytes(3, 4);
  const reference = imageInputReferenceOf(png, target);
  assert.equal(reference.mimeType, "image/png");
  assert.equal(reference.dataUrl, `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  assert.match(imageInputReferenceOf(jpegBytes(), target).dataUrl, /^data:image\/jpeg;base64,/);
  assert.match(imageInputReferenceOf(webpBytes(), target).dataUrl, /^data:image\/webp;base64,/);

  assert.throws(() => imageInputReferenceOf(new Uint8Array(), target), /参照画像が空です/);
  assert.throws(() => imageInputReferenceOf(new Uint8Array(Buffer.from("<html>")), target), /参照画像として使えるのは/);
  assert.throws(() => imageInputReferenceOf(new Uint8Array(IMAGE_INPUT_MAX_BYTES + 1), target), /大きすぎます/);
  assert.throws(() => imageInputReferenceOf(pngBytes(20_000, 20_000), target), /画素数が上限を超えています/);
});

test("入力画像の data URL と base64 は本文から取り除く", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const text = `invalid image: data:image/png;base64,${base64} and ${base64}`;
  const stripped = stripImageInputData(text, [base64]);
  assert.ok(!stripped.includes(base64), stripped);
  assert.ok(!stripped.includes("data:image/png"), stripped);
  assert.match(stripped, /data:<image omitted>/);
  // 宣言が無い data URL もパターンだけで落とす
  assert.equal(stripImageInputData("see data:image/webp;base64,AAAA"), "see data:<image omitted>");
});

test("JSON / URL エンコードで反射された入力も除去し、取り除けない残りは漏れとして検出する", () => {
  // スラッシュを含む base64（PNG の典型）。JSON 文字列では `\/`、URL エンコードでは `%2F` になる
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  for (const escaped of ["\\/", "\\u002f", "%2F"]) {
    const payload = base64.replaceAll("/", escaped);
    const reflected = JSON.stringify({ input_references: [{ url: `data:image/png;base64,${payload}` }] });
    const stripped = stripImageInputData(reflected, [base64]);
    assert.ok(!stripped.includes(payload), `${escaped}: 反射が残っている`);
    assert.ok(!stripped.includes(base64), `${escaped}: base64 が残っている`);
    assert.equal(leaksImageInputData(stripped, [base64]), false, `${escaped}: 除去後に漏れと判定した`);
  }
  // 折り返し（76 桁）で改行が入っても、比較用の正規化で漏れを見つける
  const wrapped = (base64.match(/.{1,20}/g) ?? []).join("\n");
  assert.equal(leaksImageInputData(`invalid image: ${wrapped}`, [base64]), true);
  assert.equal(leaksImageInputData("provider said no", [base64]), false);
});
