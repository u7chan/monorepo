// 共有物カードの ⋯ の位置。一覧の更新でカードがスクロール枠の外へ動いたときに、
// viewport 内へ clamp して残すのではなく閉じる（別カードの上に元の共有物の操作を残さない）ことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { ROW_MENU_MARGIN } from "../src/lib/rowMenu";
import { sharedContentMenuPosition } from "../src/lib/sharedContentMenu";

const VIEWPORT = { width: 390, height: 844 };
const VIEWPORT_CLIP = { top: 0, left: 0, right: 390, bottom: 844 };
const LIST_CLIP = { top: 0, left: 0, right: 390, bottom: 500 };
const MENU = { width: 180, height: 120 };

const anchor = (overrides: Partial<{ top: number; left: number; right: number; bottom: number }> = {}) => ({
  top: 10,
  left: 100,
  right: 136,
  bottom: 46,
  ...overrides,
});

test("⋯ の位置: アンカーが viewport と一覧のスクロール枠に見えるときだけ座標を返す", () => {
  const position = sharedContentMenuPosition(anchor(), MENU, VIEWPORT, [VIEWPORT_CLIP, LIST_CLIP]);
  assert.ok(position, "見えているアンカーは位置を返す");
});

test("⋯ の位置: 一覧の更新でアンカーがスクロール枠の外へ動いたら閉じる", () => {
  // カードが一覧の下へ押し出された（スクロールはしていない）。viewport には入っているが枠の外
  assert.equal(
    sharedContentMenuPosition(anchor({ top: 480, bottom: 516 }), MENU, VIEWPORT, [VIEWPORT_CLIP, LIST_CLIP]),
    null,
  );
  // viewport の上へ出た
  assert.equal(
    sharedContentMenuPosition(anchor({ top: -20, bottom: 16 }), MENU, VIEWPORT, [VIEWPORT_CLIP, LIST_CLIP]),
    null,
  );
});

test("⋯ の位置: 見えているアンカーは右端で viewport 内へ寄せる", () => {
  const position = sharedContentMenuPosition(anchor({ left: 354, right: 390 }), MENU, VIEWPORT, [
    VIEWPORT_CLIP,
    LIST_CLIP,
  ]);
  assert.equal(position?.left, VIEWPORT.width - MENU.width - ROW_MENU_MARGIN);
});
