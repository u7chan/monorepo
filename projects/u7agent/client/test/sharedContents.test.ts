// 共有ダイアログの純関数。公開の状態は status と lastError の組で読み、確認画面に確定 URL を出さないこと、
// ポーリングの宛先 (受付した 1 件は詳細、他は一覧) を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARE_CONFIRM_NOTES,
  shareItemsPublishing,
  sharePollPlan,
  shareStatusView,
  withSharedContent,
} from "../src/lib/sharedContents";
import type { SharedContentResponse } from "../src/types";

const base: SharedContentResponse = {
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  provider: "cloudflare",
  status: "publishing",
  publicUrl: "https://u7s-abc123.demo.workers.dev/",
  createdAt: 1,
  updatedAt: 1,
  publishedAt: null,
  stoppedAt: null,
  lastError: null,
};

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({ ...base, ...overrides });

test("状態の見せ方: 公開中・公開済み・停止中・失敗と、結果不明を openUrl と note で区別する", () => {
  assert.deepEqual(shareStatusView(item()), { label: "公開中", tone: "busy", openUrl: null, note: null });
  assert.deepEqual(shareStatusView(item({ status: "published" })), {
    label: "公開済み",
    tone: "ok",
    openUrl: base.publicUrl,
    note: null,
  });
  // 再公開の失敗は前の版が生きている。URL は開かせ、理由も添える
  assert.deepEqual(shareStatusView(item({ status: "published", lastError: "公開に失敗しました" })), {
    label: "公開済み",
    tone: "ok",
    openUrl: base.publicUrl,
    note: "公開に失敗しました",
  });
  assert.deepEqual(shareStatusView(item({ status: "stopped" })), {
    label: "停止中",
    tone: "warn",
    openUrl: null,
    note: null,
  });
  assert.deepEqual(shareStatusView(item({ status: "failed", lastError: "index.html がありません" })), {
    label: "公開できませんでした",
    tone: "danger",
    openUrl: null,
    note: "index.html がありません",
  });
  // 結果不明は「公開中」と言い切らない (外部が公開されているかを確定できていない)
  assert.deepEqual(shareStatusView(item({ lastError: "公開の結果を確認できませんでした" })), {
    label: "結果不明",
    tone: "warn",
    openUrl: null,
    note: "公開の結果を確認できませんでした",
  });
});

test("確認の条件: 対象外の URL を出さず、外部公開・秘密値・URL 発行・serve との区別を含む", () => {
  const all = SHARE_CONFIRM_NOTES.join("\n");
  assert.match(all, /誰でも見られます/);
  assert.match(all, /秘密値/);
  assert.match(all, /公開前には表示できません/);
  assert.match(all, /サービス（一時プレビュー）とは別/);
  assert.equal(
    SHARE_CONFIRM_NOTES.some((note) => /https?:\/\//.test(note)),
    false,
    "確認画面に確定 URL を出さない",
  );
});

test("ポーリングの宛先: 受付した 1 件は詳細、他の公開中は一覧、進行中が無ければ読まない", () => {
  assert.deepEqual(sharePollPlan("abc123", []), { kind: "detail", id: "abc123" });
  assert.deepEqual(sharePollPlan("abc123", [item()]), { kind: "detail", id: "abc123" });
  assert.deepEqual(sharePollPlan("abc123", [item({ status: "published" })]), null);
  assert.deepEqual(sharePollPlan(null, [item()]), { kind: "list" });
  assert.deepEqual(sharePollPlan(null, [item({ status: "published" }), item({ id: "def456" })]), { kind: "list" });
  assert.equal(shareItemsPublishing([item({ status: "published" })]), false);
  assert.equal(shareItemsPublishing([item({ status: "published" }), item({ id: "def456" })]), true);
});

test("受付した 1 件の反映: 同じ id は差し替え、未取得なら先頭へ足す", () => {
  const published = item({ status: "published" });
  assert.deepEqual(withSharedContent([item()], published), [published]);
  const other = item({ id: "def456" });
  assert.deepEqual(withSharedContent([other], published), [published, other]);
});
