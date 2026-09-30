// 画像プレビューのパス行に出すメタ表記 (寸法 · サイズ)。寸法は `<img>` の読み込み後に、サイズはツリーの行から
// 来るため、片方だけ分かることがある。どちらも無いときは null にして行ごと出さない契約が崩れると、
// 「undefined × undefined」や空の行がパス行に出る。値の丸めは formatBytes (添付のチップと同じ) が正。
import assert from "node:assert/strict";
import test from "node:test";
import { imageMetaLabel } from "../src/lib/imageMeta";

test("寸法とサイズの両方が分かるときは 寸法 · サイズ の順に並べる", () => {
  assert.equal(imageMetaLabel(25000, { width: 1536, height: 1536 }), "1536 × 1536 · 24.4 KB");
  assert.equal(imageMetaLabel(512, { width: 32, height: 32 }), "32 × 32 · 512 B");
});

test("片方だけ分かるときは分かる項目だけを出す", () => {
  assert.equal(imageMetaLabel(25000, undefined), "24.4 KB", "寸法がまだ無い (読み込み前)");
  assert.equal(imageMetaLabel(undefined, { width: 64, height: 48 }), "64 × 48", "ツリーに行が無い面");
});

test("どちらも分からないときは null (パス行に何も出さない)", () => {
  assert.equal(imageMetaLabel(undefined, undefined), null);
});

test("不正な値は落とし、0 のサイズは 0 B として残す", () => {
  assert.equal(imageMetaLabel(Number.NaN, undefined), null, "壊れたサイズを表記にしない");
  assert.equal(imageMetaLabel(-1, undefined), null);
  assert.equal(imageMetaLabel(0, undefined), "0 B", "空のファイルはサイズ 0 として出す");
  assert.equal(imageMetaLabel(undefined, { width: 0, height: 100 }), null, "寸法 0 は未取得と同じ扱い");
  assert.equal(imageMetaLabel(undefined, { width: Number.NaN, height: 10 }), null);
  // 寸法が壊れていても、分かるサイズは残す
  assert.equal(imageMetaLabel(2048, { width: 0, height: 0 }), "2.0 KB");
});
