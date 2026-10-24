// 共有ダイアログのプレビューの純関数。件数はディレクトリも数えるため「ファイル数」と言わないこと、
// 打ち切りと公開されないもの (symlink など) を注記へ回すことを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { formatByteSize, SHARE_PREVIEW_ROWS, sharePreviewSummary } from "../src/lib/sharedContentPreview";
import type { SharedContentPreviewResponse } from "../src/types";

const preview = (overrides: Partial<SharedContentPreviewResponse> = {}): SharedContentPreviewResponse => ({
  sourcePath: "projects/app/dist",
  entries: 3,
  bytes: 2048,
  files: [
    { name: "index.html", size: 1024 },
    { name: "assets/app.js", size: 1024 },
  ],
  truncated: false,
  links: [],
  linksTruncated: false,
  oversizeFiles: [],
  oversizeTruncated: false,
  hasIndexHtml: true,
  skipped: [],
  excludeNames: [],
  limited: false,
  problems: [],
  ...overrides,
});

test("サイズは 3 桁になるまで単位を上げ、1 KiB 未満はバイトで出す", () => {
  assert.equal(formatByteSize(0), "0 B");
  assert.equal(formatByteSize(1023), "1023 B");
  assert.equal(formatByteSize(1024), "1 KB");
  assert.equal(formatByteSize(1536), "1.5 KB");
  assert.equal(formatByteSize(25 * 1024 * 1024), "25 MB");
});

test("件数 (ディレクトリを含む) と合計サイズ、上位の一覧を出す", () => {
  const summary = sharePreviewSummary(preview({ entries: 1200 }));
  assert.equal(summary.totals, "1,200 件（ディレクトリを含む）・合計 2 KB");
  assert.deepEqual(summary.rows, [
    { name: "index.html", size: "1 KB" },
    { name: "assets/app.js", size: "1 KB" },
  ]);
  assert.deepEqual(summary.notes, []);
});

test("一覧は先頭だけを並べ、取得の打ち切りは注記で知らせる", () => {
  const files = Array.from({ length: SHARE_PREVIEW_ROWS + 1 }, (_, index) => ({
    name: `file-${index}.js`,
    size: 1,
  }));
  const summary = sharePreviewSummary(preview({ files, truncated: true, entries: files.length }));
  assert.equal(summary.rows.length, SHARE_PREVIEW_ROWS);
  assert.deepEqual(summary.notes, [
    `一覧は先頭 ${files.length} 件までしか取得できていません。`,
    `一覧は先頭 ${SHARE_PREVIEW_ROWS} 件だけを表示しています（残り 1 件）。`,
  ]);
});

// 11〜500 件では sandbox の truncated が false になるため、表示側の絞り込みを別の注記にしないと
// 公開対象 (例: 最上位の AGENTS.md) が見えないまま省略されたことも分からなくなる
test("11 件以上では、表示の絞り込みを取得の打ち切りとは別に知らせる", () => {
  const files = Array.from({ length: SHARE_PREVIEW_ROWS + 2 }, (_, index) => ({
    name: `file-${index}.js`,
    size: 1,
  }));
  const summary = sharePreviewSummary(preview({ files, truncated: false, entries: files.length }));
  assert.equal(summary.rows.length, SHARE_PREVIEW_ROWS);
  assert.deepEqual(summary.notes, [`一覧は先頭 ${SHARE_PREVIEW_ROWS} 件だけを表示しています（残り 2 件）。`]);
});

test("取得は打ち切られていても全件を表示できるなら、取得の打ち切りだけを知らせる", () => {
  const files = Array.from({ length: SHARE_PREVIEW_ROWS }, (_, index) => ({ name: `file-${index}.js`, size: 1 }));
  const summary = sharePreviewSummary(preview({ files, truncated: true, entries: files.length + 5 }));
  assert.equal(summary.rows.length, SHARE_PREVIEW_ROWS);
  assert.deepEqual(summary.notes, [`一覧は先頭 ${files.length} 件までしか取得できていません。`]);
});

test("取得した一覧が上限までとれていても、行数の絞り込みは一覧の件数から数える", () => {
  const files = Array.from({ length: 500 }, (_, index) => ({ name: `file-${index}.js`, size: 1 }));
  const summary = sharePreviewSummary(preview({ files, truncated: false, entries: 12_000 }));
  assert.equal(summary.rows.length, SHARE_PREVIEW_ROWS);
  assert.deepEqual(summary.notes, [`一覧は先頭 ${SHARE_PREVIEW_ROWS} 件だけを表示しています（残り 490 件）。`]);
});

test("symlink など公開されないものはパスを並べ、多い分は件数だけを示す", () => {
  const links = Array.from({ length: 7 }, (_, index) => `link-${index}`);
  const summary = sharePreviewSummary(preview({ links, linksTruncated: true }));
  assert.deepEqual(summary.notes, [
    "symlink など公開されないもの: link-0, link-1, link-2, link-3, link-4 ほか 2 件",
    "公開されないものは他にもあります。",
  ]);
});

test("上限超過 (limited) は件数を出さず、一覧も index.html の有無も判定できないと伝える", () => {
  const summary = sharePreviewSummary(
    preview({
      entries: null,
      bytes: null,
      files: [],
      hasIndexHtml: null,
      limited: true,
      problems: ["公開するファイルが多すぎます（最大 10,000 件）"],
    }),
  );
  assert.equal(summary.totals, null);
  assert.deepEqual(summary.rows, []);
  assert.deepEqual(summary.notes, ["上限を超えているため、一覧と index.html の有無を確認できませんでした。"]);
});
