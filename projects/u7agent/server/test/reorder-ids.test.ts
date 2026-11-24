import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReorderIds } from "../src/reorder-ids";

test("並べ替えは未知・重複・非文字列を捨て、未指定を元の相対順で末尾に置く", () => {
  assert.deepEqual(normalizeReorderIds(["b", "c", "a", "d", "e", "2"], ["e", "outside", "e", 2, "c", "e"]), [
    "e",
    "c",
    "b",
    "a",
    "d",
    "2",
  ]);
});

test("並べ替えの指定が空なら、現在の順序を保つ", () => {
  assert.deepEqual(normalizeReorderIds(["c", "a", "b"], []), ["c", "a", "b"]);
});
