import assert from "node:assert/strict";
import test from "node:test";
import { keepSharedContentHeadingVisible } from "../src/lib/sharedContentsScroll";

function viewport(heading: { top: number; bottom: number }, belongs = true) {
  const target = {
    getBoundingClientRect: () => ({ ...heading, height: heading.bottom - heading.top }),
  } as HTMLElement;
  const scroller = {
    scrollTop: 350,
    clientTop: 2,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100 }),
    contains: (element: HTMLElement) => belongs && element === target,
  } as HTMLElement;
  keepSharedContentHeadingVisible(scroller, target);
  return scroller.scrollTop;
}

test("畳んだ見出しが上に消えたら、一覧の上端へ戻す", () => {
  assert.equal(viewport({ top: -50, bottom: -6 }), 198);
});

test("畳んだ見出しの上端が隠れたら、一覧の上端へ戻す", () => {
  assert.equal(viewport({ top: 92, bottom: 136 }), 340);
});

test("見出しの下端が隠れたら、一覧の下端までスクロールする", () => {
  assert.equal(viewport({ top: 480, bottom: 524 }), 372);
});

test("見出しが表示されていればスクロールしない", () => {
  assert.equal(viewport({ top: 102, bottom: 146 }), 350);
  assert.equal(viewport({ top: 458, bottom: 502 }), 350);
});

test("見出しが一覧より高いときは上端を優先する", () => {
  assert.equal(viewport({ top: 200, bottom: 700 }), 448);
});

test("見出しが一覧から外れていればスクロールしない", () => {
  assert.equal(viewport({ top: -50, bottom: -6 }, false), 350);
});

test("展開時はスクロールアンカーで末尾へ飛ばないよう元の位置を戻す", () => {
  const scroller = {
    scrollTop: 1_200,
    clientTop: 0,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100 }),
    contains: () => true,
  } as unknown as HTMLElement;
  const heading = {
    getBoundingClientRect: () => {
      const top = 100 - (scroller.scrollTop - 20);
      return { top, bottom: top + 44, height: 44 };
    },
  } as HTMLElement;
  keepSharedContentHeadingVisible(scroller, heading, 20);
  assert.equal(scroller.scrollTop, 20);
});
