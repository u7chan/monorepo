// 共有の除外名の検証（client/src/lib/sharedContentExclusions.ts）。アーカイブと同じ 1 セグメント名の規則に、
// 共有だけの規則（index.html は公開に必要なので除外できない）を足すことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { SHARED_CONTENT_INDEX_ERROR, validateSharedContentExcludeNames } from "../src/lib/sharedContentExclusions";

const draft = (...excludeNames: string[]) => ({ excludeNames });

test("公開に必要な index.html は除外できない", () => {
  assert.equal(validateSharedContentExcludeNames(draft("AGENTS.md"), 100, 200), undefined);
  assert.equal(validateSharedContentExcludeNames(draft("index.html"), 100, 200), SHARED_CONTENT_INDEX_ERROR);
  assert.equal(
    validateSharedContentExcludeNames(draft("AGENTS.md", "index.html"), 100, 200),
    SHARED_CONTENT_INDEX_ERROR,
  );
});

test("1 セグメント名の規則と上限はダウンロードの除外と同じ", () => {
  assert.equal(validateSharedContentExcludeNames(draft("a/b"), 100, 200), "除外名に使えない名前があります: a/b");
  assert.equal(validateSharedContentExcludeNames(draft("a\\b"), 100, 200), "除外名に使えない名前があります: a\\b");
  assert.equal(validateSharedContentExcludeNames(draft("."), 100, 200), "除外名に使えない名前があります: .");
  assert.equal(
    validateSharedContentExcludeNames(draft("x".repeat(201)), 100, 200),
    "除外名に使えない名前があります: " + "x".repeat(201),
  );
  assert.equal(
    validateSharedContentExcludeNames(draft(...Array.from({ length: 101 }, (_, index) => `n-${index}`)), 100, 200),
    "除外名は 100 件までです",
  );
});
