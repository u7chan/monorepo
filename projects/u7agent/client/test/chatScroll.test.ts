import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ScrollToBottomButton } from "../src/components/chat/ScrollToBottomButton";
import { CHAT_FOLLOW_THRESHOLD, isAtBottom, resolveScrollFollow, shouldLoadOlder } from "../src/lib/chatScroll";

test("最下部の判定はしきい値 48px ちょうどまで追従する", () => {
  // 高さ 800 の容器に内容 2000 を入れた状態 (最下部は scrollTop = 1200)
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 800 });

  assert.equal(isAtBottom(at(1200)), true); // ちょうど最下部
  assert.equal(isAtBottom(at(1200 - CHAT_FOLLOW_THRESHOLD)), true); // しきい値ちょうど
  assert.equal(isAtBottom(at(1200 - CHAT_FOLLOW_THRESHOLD - 0.5)), false); // 端数で 1 つ外
  assert.equal(isAtBottom(at(0)), false); // 上端
});

test("内容が収まっている / 空のときは最下部とみなす", () => {
  // 内容が容器に収まる (scrollTop は常に 0 になる) ときは、追従を外す余地がない
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 800 }), true);
  // 高さを持たない容器 (非表示中や未描画) でも判定できる
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), true);
});

test("追従中は位置が増える scroll (レイアウト起因 / snap の代入) で追従を外さない", () => {
  // 右パネルを開いた再折り返し (実測: scrollHeight 10291 → 13021、最下部 12347)。アンカリングが
  // scrollTop を 9374 → 11922 へ増やし、最下部から 425px 離れた scroll を ResizeObserver より先に配る
  const resized = { scrollHeight: 13021, clientHeight: 674 };
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 9374, scrollTop: 11922, ...resized }), {
    follow: true,
    snap: true,
  });
  // 位置が同じ (snap の代入が動かさなかった) もユーザー操作ではない。最下部なら書き戻さない
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 12347, scrollTop: 12347, ...resized }), {
    follow: true,
    snap: false,
  });
});

test("上へ戻す scroll は追従中でも距離で判定する", () => {
  const resized = { scrollHeight: 13021, clientHeight: 674 };
  // 48px ちょうどまでは追従を続け、端数で外れる
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 12347, scrollTop: 12347 - 48, ...resized }), {
    follow: true,
    snap: false,
  });
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 12347, scrollTop: 12347 - 49, ...resized }), {
    follow: false,
    snap: false,
  });
  // snap の代入とイベント配送の間にユーザーが戻した場合も、位置が減るのでこの経路で外れる
  assert.deepEqual(resolveScrollFollow({ follow: true, previousTop: 9000, scrollTop: 8000, ...resized }), {
    follow: false,
    snap: false,
  });
});

test("読み返し中は位置が増えても追従を戻さず、48px 以内へ戻ったときだけ再開する", () => {
  const resized = { scrollHeight: 13021, clientHeight: 674 };
  // レイアウト起因で位置が増えても、読み位置を動かさない
  assert.deepEqual(resolveScrollFollow({ follow: false, previousTop: 5000, scrollTop: 6000, ...resized }), {
    follow: false,
    snap: false,
  });
  assert.deepEqual(resolveScrollFollow({ follow: false, previousTop: 5000, scrollTop: 12347 - 48, ...resized }), {
    follow: true,
    snap: false,
  });
});

test("上端付近で古いページの先読みを 1 回だけ要求する", () => {
  assert.equal(shouldLoadOlder({ scrollTop: 0, hasMore: true, loading: false }), true);
  assert.equal(shouldLoadOlder({ scrollTop: 200, hasMore: true, loading: false }), true); // しきい値ちょうど
  assert.equal(shouldLoadOlder({ scrollTop: 201, hasMore: true, loading: false }), false);
  assert.equal(shouldLoadOlder({ scrollTop: 0, hasMore: false, loading: false }), false, "先頭まで読んだら要求しない");
  assert.equal(shouldLoadOlder({ scrollTop: 0, hasMore: true, loading: true }), false, "取得中は重ねて要求しない");
});

test("ScrollToBottomButton は最新へ戻るボタンとして読み上げられる", () => {
  const html = renderToStaticMarkup(
    createElement(ScrollToBottomButton, {
      onClick: () => {},
    }),
  );

  assert.ok(html.includes('type="button"'));
  assert.ok(html.includes('aria-label="最新のメッセージへ移動"'));
});
