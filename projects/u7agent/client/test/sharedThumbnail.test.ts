// What: サムネイルの切り抜き計算（16:10・原寸を超えない出力・倍率の上限・キーボード操作・版付き URL・
// 一覧の版を巻き戻さない差し替え）を固定する。canvas と File のデコードは DOM 依存なのでここでは扱わない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_THUMBNAIL_CROP,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_MIN_WIDTH,
  clampThumbnailCrop,
  panThumbnailCrop,
  sharedContentThumbnailUrl,
  thumbnailCropRect,
  thumbnailFrame,
  thumbnailKeyStep,
  thumbnailMaxZoom,
  thumbnailSourceProblem,
  withSharedContentThumbnail,
} from "../src/lib/sharedThumbnail";
import type { SharedContentResponse, SharedContentThumbnail } from "../src/types";

const thumbnail = (updatedAt: number): SharedContentThumbnail => ({
  updatedAt,
  width: 800,
  height: 500,
  bytes: 1000,
});

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  sourceKind: "directory",
  provider: "cloudflare",
  status: "published",
  publicUrl: "https://u7s-abc123.demo.workers.dev/",
  createdAt: 1,
  updatedAt: 1,
  publishedAt: 2,
  stoppedAt: null,
  lastError: null,
  thumbnail: null,
  ...overrides,
});

test("枠: 画像に内接する 16:10 で、横幅が足りない画像は幅が基準になる", () => {
  assert.deepEqual(thumbnailFrame(1600, 1000), { width: 1600, height: 1000 });
  // 横長: 高さから決まる
  assert.deepEqual(thumbnailFrame(3000, 1000), { width: 1600, height: 1000 });
  // 縦長: 幅から決まる
  assert.deepEqual(thumbnailFrame(800, 2000), { width: 800, height: 500 });
});

test("出力は 16:10 で上限を超えず、拡大すると切り抜き範囲だけが狭くなる", () => {
  const rect = thumbnailCropRect(INITIAL_THUMBNAIL_CROP, 3000, 2000);
  // 切り抜き範囲は原寸のまま。保存する PNG だけが上限に収まる
  assert.equal(rect.sw, 3000);
  assert.equal(rect.sh, 1875);
  assert.equal(rect.outputWidth, THUMBNAIL_MAX_WIDTH);
  assert.equal(rect.outputHeight, 1000);

  const zoomed = thumbnailCropRect({ zoom: 2, offsetX: 0, offsetY: 0 }, 3000, 2000);
  assert.equal(zoomed.sw, 1500);
  assert.equal(zoomed.sh, 937.5);
  // 倍率を上げると出力も小さくなり、原寸を超えて引き伸ばさない
  assert.equal(zoomed.outputWidth, 1496);
  assert.equal(zoomed.outputHeight, 935);
  assert.ok(zoomed.outputWidth <= zoomed.sw);
});

test("出力幅は 8 の倍数（16:10 を整数の高さで表せる刻み）になる", () => {
  for (const width of [1000, 1024, 1001, 1203]) {
    const rect = thumbnailCropRect(INITIAL_THUMBNAIL_CROP, width, Math.round(width / 1.6));
    assert.equal(rect.outputWidth % 8, 0, `width ${width}`);
    assert.equal(rect.outputHeight, rect.outputWidth / 1.6);
    assert.equal(Number.isInteger(rect.outputHeight), true);
  }
});

test("倍率の上限は出力が最小幅を割らない範囲で、範囲外の値は丸める", () => {
  const maxZoom = thumbnailMaxZoom(1600, 1000);
  assert.equal(maxZoom, THUMBNAIL_MAX_WIDTH / THUMBNAIL_MIN_WIDTH);
  assert.equal(
    thumbnailCropRect({ zoom: maxZoom, offsetX: 0, offsetY: 0 }, 1600, 1000).outputWidth,
    THUMBNAIL_MIN_WIDTH,
  );

  const tooFar = clampThumbnailCrop({ zoom: 99, offsetX: 5, offsetY: -5 }, 1600, 1000);
  assert.equal(tooFar.zoom, maxZoom);
  assert.equal(tooFar.offsetX, 1);
  assert.equal(tooFar.offsetY, -1);
  // 数値でない値は中央・等倍へ倒す
  assert.deepEqual(clampThumbnailCrop({ zoom: Number.NaN, offsetX: Number.NaN, offsetY: 0 }, 1600, 1000), {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
});

test("小さい画像は保存の前に理由を返す", () => {
  assert.equal(thumbnailSourceProblem(320, 200), undefined);
  assert.match(thumbnailSourceProblem(300, 200) ?? "", /小さすぎます/);
  assert.match(thumbnailSourceProblem(1600, 50) ?? "", /小さすぎます/);
});

test("ドラッグは移動量を切り抜き範囲の比へ直し、端で止まる", () => {
  // 横に余白がある画像（3000x1000）で、プレビュー 480px を右へ 48px 動かす = 画像の 1/10 を左へ
  const panned = panThumbnailCrop(INITIAL_THUMBNAIL_CROP, { dx: 48, dy: 0 }, 480, 300, 3000, 1000);
  assert.ok(panned.offsetX < 0, "画像を右へ動かすと切り抜きは左へ寄る");
  assert.equal(panned.offsetY, 0);
  // 端を越える移動は 1 で止まる
  const edge = panThumbnailCrop(INITIAL_THUMBNAIL_CROP, { dx: -100000, dy: 100000 }, 480, 300, 3000, 1000);
  assert.equal(edge.offsetX, 1);
  // 余白が無い方向（縦は枠いっぱい）は動かさない
  assert.equal(edge.offsetY, 0);
});

test("矢印キーで位置、+ / - で倍率を変える。扱わないキーは状態を変えない", () => {
  const right = thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "ArrowRight", 1600, 1000);
  assert.equal(right?.offsetX, 0.1);
  const down = thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "ArrowDown", 1600, 1000);
  assert.equal(down?.offsetY, 0.1);
  // 余白が無い方向でも状態としては動く（クランプは描画時に効く）
  assert.equal(thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "ArrowLeft", 1600, 1000)?.offsetX, -0.1);
  assert.equal(thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "Tab", 1600, 1000), undefined);
  assert.equal(thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "Enter", 1600, 1000), undefined);

  const zoomIn = thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "+", 1600, 1000);
  assert.equal(zoomIn?.zoom, 1.1);
  assert.equal(thumbnailKeyStep(INITIAL_THUMBNAIL_CROP, "-", 1600, 1000)?.zoom, 1);
  // 上限を超える拡大は丸める
  const beyond = thumbnailKeyStep({ zoom: 100, offsetX: 0, offsetY: 0 }, "+", 1600, 1000);
  assert.equal(beyond?.zoom, thumbnailMaxZoom(1600, 1000));
});

test("配信 URL は版をクエリに載せ、id をエスケープする", () => {
  assert.equal(
    sharedContentThumbnailUrl("abc123", 1700000000000),
    "/api/shared-contents/abc123/thumbnail?v=1700000000000",
  );
  assert.equal(sharedContentThumbnailUrl("a b", 1), "/api/shared-contents/a%20b/thumbnail?v=1");
});

test("一覧の差し替えは版を巻き戻さず、解除は未設定へ倒す", () => {
  const older = item({ thumbnail: thumbnail(10) });
  const other = item({ id: "other", thumbnail: null });
  // 保存の応答（新しい版）を反映する
  const replaced = withSharedContentThumbnail([older, other], "abc123", thumbnail(20));
  assert.equal(replaced[0]?.thumbnail?.updatedAt, 20);
  assert.equal(replaced[1]?.thumbnail, null);
  // 保存より前に発行した一覧（古い版）が遅れて届いても巻き戻さない
  const stale = withSharedContentThumbnail(replaced, "abc123", thumbnail(15));
  assert.equal(stale[0]?.thumbnail?.updatedAt, 20);
  // 解除は未設定へ倒す（版の比較より優先する）
  const cleared = withSharedContentThumbnail(stale, "abc123", null);
  assert.equal(cleared[0]?.thumbnail, null);
  // 対象外の行はそのまま
  assert.deepEqual(cleared[1], other);
});
