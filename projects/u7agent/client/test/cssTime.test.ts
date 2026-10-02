// ドロワーの退場アニメの長さを CSS から読む保険タイマー (NavSheet) が使う時間値の読み方を固定する。
// computed の `animation-duration` はカンマ区切りのリストになり得るので、先頭だけを読むと実際に動いて
// いる長い値を取りこぼす (docs/ui-layout.md#サイドバー)。
import assert from "node:assert/strict";
import test from "node:test";
import { maxDurationMs } from "../src/lib/cssTime";

test("時間値のリストは最大を ms で返す", () => {
  assert.equal(maxDurationMs("0.18s"), 180);
  // 外部 CSS が `animation-duration: 0s, 180ms` のように重ねた場合。先頭だけ読むと 0s になり、
  // 180ms の退場アニメを 100ms の保険が途中で切る
  assert.equal(maxDurationMs("0s, 0.18s"), 180);
  assert.equal(maxDurationMs("0.18s, 200ms"), 200);
  assert.equal(maxDurationMs(" 0.5s , 0.25s "), 500);
});

test("時間値が無いときは 0", () => {
  assert.equal(maxDurationMs(""), 0);
  assert.equal(maxDurationMs("0s"), 0);
  // `animation: none` の computed は `0s`。単位の無い値と空要素は無視する
  assert.equal(maxDurationMs("none"), 0);
  assert.equal(maxDurationMs("0s, "), 0);
});
