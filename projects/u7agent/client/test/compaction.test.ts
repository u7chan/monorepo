// 圧縮位置の区切りと要約一覧の整形。locale に依存しない純関数なので境界値を固定値で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  compactionDividerIndex,
  compactionDividerLabel,
  compactionHistoryLabel,
  compactionReasonLabel,
  compactionSummaryHeading,
} from "../src/lib/compaction";
import type { CompactionInfo } from "../src/types";

function compaction(overrides: Partial<CompactionInfo> = {}): CompactionInfo {
  return {
    id: "entry-compaction-1",
    parentId: "entry-2",
    timestamp: "2026-09-13T00:00:00.000Z",
    summary: "これまでの会話の要約",
    firstKeptEntryId: "entry-3",
    tokensBefore: 68_000,
    ...overrides,
  };
}

test("区切りは reason を区別して圧縮前トークンと一緒に出す", () => {
  assert.equal(
    compactionDividerLabel(compaction({ reason: "threshold" })),
    "ここで会話を圧縮しました（自動: 68k tokens から）",
  );
  assert.equal(
    compactionDividerLabel(compaction({ reason: "manual", tokensBefore: 4200 })),
    "ここで会話を圧縮しました（手動: 4.2k tokens から）",
  );
  assert.equal(
    compactionDividerLabel(compaction({ reason: "overflow", tokensBefore: 1_200_000 })),
    "ここで会話を圧縮しました（上限超過: 1.2M tokens から）",
  );
  // reason は compaction_end を受けた BFF のプロセスでしか分からないため、無ければ tokens だけ出す
  assert.equal(compactionDividerLabel(compaction()), "ここで会話を圧縮しました（68k tokens から）");
});

test("reason のラベルは manual / threshold / overflow を区別する", () => {
  assert.equal(compactionReasonLabel("manual"), "手動");
  assert.equal(compactionReasonLabel("threshold"), "自動");
  assert.equal(compactionReasonLabel("overflow"), "上限超過");
  assert.equal(compactionReasonLabel(undefined), undefined);
  assert.equal(compactionReasonLabel(""), undefined);
});

test("要約一覧の見出しは時系列の通し番号で何回目かを示す", () => {
  assert.equal(compactionSummaryHeading(compaction({ reason: "threshold" }), 0), "1回目 · 自動 · 68k tokens");
  // reason が無い (サーバー再起動で控えを失った) ときは番号とトークンだけ
  assert.equal(compactionSummaryHeading(compaction(), 1), "2回目 · 68k tokens");
});

test("回数の注記は複数回圧縮されたときだけ出す", () => {
  assert.equal(compactionHistoryLabel(0), undefined);
  assert.equal(compactionHistoryLabel(1), undefined);
  assert.equal(compactionHistoryLabel(3), "この会話は 3 回圧縮されました");
});

test("区切りの index は最新の 1 件の beforeMessageIndex だけから取る", () => {
  assert.equal(compactionDividerIndex([]), undefined);
  assert.equal(compactionDividerIndex([compaction()]), undefined, "位置が無ければ区切りを出さない");
  assert.equal(compactionDividerIndex([compaction({ beforeMessageIndex: 0 })]), 0);
  // 最新が位置を持たないなら、過去の位置は使わない
  assert.equal(compactionDividerIndex([compaction({ beforeMessageIndex: 2 }), compaction()]), undefined);
  // 複数あっても読むのは最新だけ
  assert.equal(
    compactionDividerIndex([
      compaction({ id: "old", beforeMessageIndex: 9 }),
      compaction({ id: "latest", beforeMessageIndex: 4 }),
    ]),
    4,
  );
});
