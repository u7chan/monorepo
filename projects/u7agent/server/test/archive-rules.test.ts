// server/src/archive-rules.ts（除外名の実効値）と、その開示（GET /api/health の archive.excludeNames）。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import {
  ARCHIVE_EXCLUDE_COUNT_ERROR,
  ARCHIVE_EXCLUDE_MAX_NAME_LENGTH,
  ARCHIVE_EXCLUDE_MAX_NAMES,
  ARCHIVE_EXCLUDE_NAME_ERROR,
  DEFAULT_ARCHIVE_EXCLUDE_NAMES,
  normalizeArchiveExcludeNames,
  resolveArchiveExcludeNames,
  validateArchiveExcludeNames,
} from "../src/archive-rules";

test("既定の除外名は再生成物とビルド成果物だけで、vendor や public は入れない", () => {
  const names = [...DEFAULT_ARCHIVE_EXCLUDE_NAMES];
  for (const name of ["node_modules", ".venv", "venv", "__pycache__", ".git"]) {
    assert.ok(names.includes(name), `再生成物が無い: ${name}`);
  }
  for (const name of [
    "dist",
    "build",
    "out",
    ".output",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "target",
    "coverage",
    ".turbo",
    ".cache",
    ".parcel-cache",
  ]) {
    assert.ok(names.includes(name), `ビルド成果物が無い: ${name}`);
  }
  // 必要になる / 成果物ではないものは除外しない
  for (const name of ["vendor", "public", "lib", "bin", "docs", ".github"]) {
    assert.ok(!names.includes(name), `除外してはいけない: ${name}`);
  }
  assert.equal(new Set(names).size, names.length, "重複がある");
});

test("resolveArchiveExcludeNames は上書きを尊重する", () => {
  assert.deepEqual(resolveArchiveExcludeNames(), [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  assert.deepEqual(resolveArchiveExcludeNames(null), [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  // 空配列は「すべて除外しない」として尊重する（既定へ戻さない）
  assert.deepEqual(resolveArchiveExcludeNames([]), []);
  assert.deepEqual(resolveArchiveExcludeNames(["dist", "dist", " node_modules ", ""]), ["dist", "node_modules"]);
  // 呼び出し側が返り値を書き換えても既定は壊れない
  const names = resolveArchiveExcludeNames();
  names.push("x");
  assert.deepEqual(resolveArchiveExcludeNames(), [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
});

test("GET /api/health は実効の除外名を返す", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    const health = (await (await bff.app.request("/api/health")).json()) as { archive?: { excludeNames?: string[] } };
    assert.deepEqual(health.archive?.excludeNames, [...DEFAULT_ARCHIVE_EXCLUDE_NAMES]);
  } finally {
    await bff.close();
  }
});

test("normalizeArchiveExcludeNames は trim / 空落とし / 先勝ちの重複畳みをし、順序と大文字小文字を保つ", () => {
  assert.deepEqual(normalizeArchiveExcludeNames([" node_modules ", "", "   ", "Node_Modules", "node_modules"]), [
    "node_modules",
    "Node_Modules",
  ]);
  // 呼び出し側の配列は書き換えない
  const input = ["dist", "dist"];
  assert.deepEqual(normalizeArchiveExcludeNames(input), ["dist"]);
  assert.deepEqual(input, ["dist", "dist"]);
  assert.deepEqual(normalizeArchiveExcludeNames([]), []);
});

test("validateArchiveExcludeNames は 1 セグメント名と件数の上限だけを拒む", () => {
  assert.equal(validateArchiveExcludeNames(["node_modules", ".git", "日本語 名前"]), undefined);
  // 空は正規化で落ちる前提なので、検証には現れない (単体では弾く)
  for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\u001fb", "a\u007fb", "x".repeat(201)]) {
    assert.equal(validateArchiveExcludeNames([bad]), `${ARCHIVE_EXCLUDE_NAME_ERROR}: ${bad}`, JSON.stringify(bad));
  }
  // 200 文字は通る
  assert.equal(validateArchiveExcludeNames(["x".repeat(ARCHIVE_EXCLUDE_MAX_NAME_LENGTH)]), undefined);
  // 100 件は通り、101 件で件数の理由を返す
  const max = Array.from({ length: ARCHIVE_EXCLUDE_MAX_NAMES }, (_, index) => `name-${index}`);
  assert.equal(validateArchiveExcludeNames(max), undefined);
  assert.equal(validateArchiveExcludeNames([...max, "extra"]), ARCHIVE_EXCLUDE_COUNT_ERROR);
  assert.equal(ARCHIVE_EXCLUDE_MAX_NAME_LENGTH, 200);
  assert.equal(ARCHIVE_EXCLUDE_MAX_NAMES, 100);
});
