// server/src/archive-rules.ts（除外名の実効値）と、その開示（GET /api/health の archive.excludeNames）。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { DEFAULT_ARCHIVE_EXCLUDE_NAMES, resolveArchiveExcludeNames } from "../src/archive-rules";

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
