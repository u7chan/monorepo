// native popover の位置決め (client/src/lib/popoverPlacement.ts) の純関数。
// 「トリガーの上を優先し、入らなければ下へ倒し、viewport の内側へ clamp する」契約を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  POPOVER_MARGIN,
  popoverAvailableHeight,
  popoverLeft,
  popoverOpensAbove,
  popoverTop,
  popoverWidth,
} from "../src/lib/popoverPlacement";

const DESKTOP_HEIGHT = 900;

test("popoverWidth は viewport が狭いときだけ左右の余白を残して縮める", () => {
  assert.equal(popoverWidth(320, 1440), 320);
  assert.equal(popoverWidth(320, 336), 320, "余白 8px を残しても収まる幅はそのまま");
  assert.equal(popoverWidth(320, 300), 284);
  assert.equal(popoverWidth(320, 12), 0, "余白すら取れない幅でも負にしない");
});

test("popoverOpensAbove は上を優先し、上に入らないときだけ下へ倒す", () => {
  // コンポーザーは画面の下端にあるため、上に十分な空きがあれば上に開く
  assert.equal(popoverOpensAbove({ top: 700, bottom: 728 }, DESKTOP_HEIGHT), true);
  // 画面の上端近くの欄 (ツールバーなど) では下へ倒す
  assert.equal(popoverOpensAbove({ top: 10, bottom: 38 }, DESKTOP_HEIGHT), false);
  // どちらも分かれ目 (160px) に満たないときは広い方 (上の 88px) を選ぶ
  assert.equal(popoverOpensAbove({ top: 100, bottom: 128 }, 200), true);
  assert.equal(popoverOpensAbove({ top: 40, bottom: 68 }, 200), false);
});

test("popoverAvailableHeight は選んだ向きの空きを返し、負にしない", () => {
  assert.equal(popoverAvailableHeight({ top: 700, bottom: 728 }, DESKTOP_HEIGHT, true), 688);
  assert.equal(popoverAvailableHeight({ top: 700, bottom: 728 }, DESKTOP_HEIGHT, false), 160);
  assert.equal(popoverAvailableHeight({ top: 10, bottom: 14 }, 20, true), 0);
});

test("popoverLeft は欄の左端にそろえ、右端ではみ出す分だけ左へ寄せる", () => {
  assert.equal(popoverLeft({ left: 300 }, 320, 1440), 300);
  assert.equal(popoverLeft({ left: 1300 }, 320, 1440), 1440 - 320 - POPOVER_MARGIN);
  assert.equal(popoverLeft({ left: 0 }, 320, 1440), POPOVER_MARGIN, "左端は余白の内側へ clamp する");
  // 幅が viewport を超えても、左端は余白の位置へ寄せる (負の座標にしない)
  assert.equal(popoverLeft({ left: 100 }, 2000, 1440), POPOVER_MARGIN);
});

test("popoverTop は上に開くとき欄の上端から高さぶん戻し、viewport の内側へ clamp する", () => {
  assert.equal(popoverTop({ top: 700, bottom: 728 }, 400, true, DESKTOP_HEIGHT), 296);
  assert.equal(popoverTop({ top: 700, bottom: 728 }, 150, false, DESKTOP_HEIGHT), 732);
  // 高さが空きを超えても上端は余白の内側に残す (見切れる分は呼び出し側の内部スクロールで出す)
  assert.equal(popoverTop({ top: 700, bottom: 728 }, 900, true, DESKTOP_HEIGHT), POPOVER_MARGIN);
});
