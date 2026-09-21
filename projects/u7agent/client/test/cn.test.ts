// className の連結。並び順は oxfmt (sortTailwindcss.functions) が引数ごとに揃えるため、
// 引数の順序がそのまま出力の順序になることを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { cn } from "../src/lib/cn";

test("空白区切りで連結し、false / null / undefined は落とす", () => {
  assert.equal(cn("flex", "gap-2"), "flex gap-2");
  assert.equal(cn("flex", false, null, undefined, "", "gap-2"), "flex gap-2");
});

test("引数の順序を保つ (並べ替えは oxfmt が行う)", () => {
  assert.equal(cn("gap-2", "flex"), "gap-2 flex");
});

test("引数が無いときは空文字を返す", () => {
  assert.equal(cn(), "");
  assert.equal(cn(false, undefined), "");
});
