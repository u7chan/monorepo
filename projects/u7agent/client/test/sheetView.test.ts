import assert from "node:assert/strict";
import test from "node:test";
import { nextSheetView, sameSheetView, type SheetView } from "../src/lib/sheetView";

const WORK = { root: "work/s1", mode: { kind: "work" } } as const satisfies SheetView;
const view = (root: string): SheetView => ({ root, mode: { kind: "work" } });

test("開いている間は live な面へ追従する (タブや面の切替を取り込む)", () => {
  assert.deepEqual(nextSheetView(WORK, view("work/s2"), true, false), view("work/s2"));
});

test("同じ面なら更新しない (同じ値の set で描画を増やさない)", () => {
  assert.equal(nextSheetView(WORK, WORK, true, false), null);
  // 構造が同じ別オブジェクト (skill 面は描画ごとに作られる) でも同じ面として扱う
  assert.equal(nextSheetView(WORK, view("work/s1"), true, false), null);
});

test("閉じている間は live を追わない (閉じる導線のモード既定戻しをスライド中の面へ入れない)", () => {
  const skill: SheetView = { root: "work/s1", mode: { kind: "skill", root: ".agents/skills/a" } };
  assert.equal(nextSheetView(skill, { root: "work/s1", mode: { kind: "work" } }, false, false), null);
});

test("scope の変更で閉じる描画では追わない (開閉 state が古くても新しい root を取り込まない)", () => {
  // root が A → B へ動く描画では filesSheetOpen が古い true のままなので、open を信じてはいけない
  assert.equal(nextSheetView(view("work/a"), view("work/b"), true, true), null);
});

test("面の同一性は root とモードの組で見る", () => {
  assert.ok(sameSheetView(view("work/a"), view("work/a")));
  assert.ok(!sameSheetView(view("work/a"), view("work/b")));
  assert.ok(!sameSheetView(view("work/a"), { root: "work/a", mode: { kind: "skill", root: ".agents/skills/a" } }));
});
