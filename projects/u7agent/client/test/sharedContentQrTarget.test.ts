// What: QR の表示対象を id で一覧から引き直すときの状態遷移を固定する
// （消えた / stopped / publishing / URL 無し / 未デプロイなら閉じる。公開元の会話が消えていても URL は生きている）。
import assert from "node:assert/strict";
import test from "node:test";
import { sharedContentQrTarget } from "../src/lib/sharedContents";
import type { SharedContentResponse } from "../src/types";

const URL_PUBLISHED = "https://u7s-abc123.demo.workers.dev/";
/** 公開が一度でも成功した時刻。`publishedAt` が無い published / stopped は未デプロイ（要更新） */
const PUBLISHED_AT = 1_000;

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  sourceKind: "directory",
  provider: "cloudflare",
  status: "published",
  publicUrl: URL_PUBLISHED,
  createdAt: 1,
  updatedAt: 1,
  publishedAt: PUBLISHED_AT,
  stoppedAt: null,
  lastError: null,
  ...overrides,
});

test("QR の対象: published かつ publicUrl がある 1 件だけを返す", () => {
  const published = item();
  assert.equal(sharedContentQrTarget([published], published.id), published);
  assert.equal(sharedContentQrTarget([published], null), null);
  assert.equal(sharedContentQrTarget([published], "def456"), null);
  // 公開中のまま lastError が付いていても、開く / コピーと同じく URL は渡せる
  const withError = item({ lastError: "更新に失敗しました" });
  assert.equal(sharedContentQrTarget([withError], withError.id), withError);
  // 公開元の会話が削除されていても、URL は生きている（開く / コピーと同じ扱い）
  const sessionGone = item({ sessionId: "gone" });
  assert.equal(sharedContentQrTarget([sessionGone], sessionGone.id), sessionGone);
});

test("QR の対象: 表示中に条件から外れたら null（呼び出し側はダイアログを閉じる）", () => {
  const id = "abc123";
  assert.equal(sharedContentQrTarget([item({ status: "stopped" })], id), null);
  assert.equal(sharedContentQrTarget([item({ status: "failed" })], id), null);
  assert.equal(sharedContentQrTarget([item({ status: "publishing" })], id), null);
  assert.equal(sharedContentQrTarget([item({ publicUrl: null })], id), null);
  // 未デプロイは URL の記録だけがあり、外部に実体が無い
  assert.equal(sharedContentQrTarget([item({ publishedAt: null })], id), null);
  // 一覧から消えた
  assert.equal(sharedContentQrTarget([], id), null);
});

test("QR の対象: 一覧の更新に追随し、対象が publishing へ変わったら null", () => {
  const id = "abc123";
  const before = sharedContentQrTarget([item()], id);
  assert.ok(before);
  assert.equal(sharedContentQrTarget([item({ status: "publishing", lastError: null })], id), null);
});
