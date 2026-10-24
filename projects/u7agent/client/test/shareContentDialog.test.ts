// 共有ダイアログの描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 確認 → 受付 → 結果の出し分け、確認画面に URL を出さないこと、失敗理由が固定文言だけであることを固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { SharedContentsController } from "../src/hooks/useSharedContents";
import { SHARE_CONFIRM_NOTES } from "../src/lib/sharedContents";
import type { SharedContentResponse } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { ShareContentDialogView } = await import("../src/components/ShareContentDialog");

const URL_PUBLISHED = "https://u7s-abc123.demo.workers.dev/";

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  provider: "cloudflare",
  status: "publishing",
  publicUrl: URL_PUBLISHED,
  createdAt: 1,
  updatedAt: 1,
  publishedAt: null,
  stoppedAt: null,
  lastError: null,
  ...overrides,
});

function controller(overrides: Partial<SharedContentsController> = {}): SharedContentsController {
  return {
    items: [],
    loading: false,
    failed: false,
    activeId: null,
    error: undefined,
    submitting: false,
    share: async () => {},
    reload: async () => {},
    ...overrides,
  };
}

function render(share: SharedContentsController): string {
  return renderToStaticMarkup(
    createElement(ShareContentDialogView, {
      target: { directory: "dist" },
      share,
      onClose: () => {},
    }),
  );
}

function actionTag(html: string, label: string): string {
  const button = html
    .match(/<button[^>]*>[\s\S]*?<\/button>/g)
    ?.find((markup) => markup.replace(/<[^>]*>/g, "").trim() === label);
  assert.ok(button, `${label} ボタンが無い`);
  return button.slice(0, button.indexOf(">") + 1);
}

test("確認: 公開対象の path と 4 つの条件を出し、確定 URL と結果の操作は出さない", () => {
  const html = render(controller());
  assert.match(html, />共有</);
  assert.match(html, /公開するディレクトリ/);
  assert.ok(html.includes(">dist<"), "公開対象のパスを出す");
  for (const note of SHARE_CONFIRM_NOTES) {
    assert.ok(html.includes(note), `確認の条件が抜けている: ${note}`);
  }
  assert.equal(html.includes("workers.dev/"), false, "確認画面に確定 URL を出さない");
  assert.equal(html.includes("URL をコピー"), false);
  assert.equal(html.includes(">開く<"), false);
  assert.ok(actionTag(html, "共有する"), "確定するボタンが無い");
  assert.equal(actionTag(html, "共有する").includes("disabled"), false);
  assert.ok(actionTag(html, "キャンセル"));
  assert.match(html, /この会話の共有物はまだありません。/);
});

test("受付中: 共有するを押せず、公開を受け付けたことを知らせる", () => {
  const html = render(controller({ submitting: true }));
  assert.match(html, /公開を受け付けています/);
  // 受付中は確定のボタンごと出さない (二重送信の経路を作らない)
  assert.equal(html.includes(">共有する<"), false);
  assert.ok(actionTag(html, "閉じる"));
  // 受付した後は確認の条件を出さない (同じディレクトリを二重に公開しない)
  assert.equal(html.includes(SHARE_CONFIRM_NOTES[0]), false);
});

test("公開中: 状態だけを出し、開く / コピーはまだ出さない", () => {
  const html = render(controller({ items: [item()], activeId: "abc123" }));
  assert.match(html, /公開中/);
  assert.ok(html.includes("共有 ID: "));
  assert.equal(html.includes("URL をコピー"), false);
  assert.equal(html.includes(">開く<"), false);
});

test("完了: URL と共有 ID と 開く / URL をコピー を結果に出す", () => {
  const html = render(controller({ items: [item({ status: "published" })], activeId: "abc123" }));
  assert.match(html, /公開済み/);
  assert.ok(html.includes("https://u7s-abc123.demo.workers.dev/"), "確定 URL を出す");
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`));
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.ok(actionTag(html, "URL をコピー"));
  assert.ok(html.includes(">abc123<"), "共有 ID を出す");
  // 受付した 1 件は結果に出すので、同じ URL とボタンを一覧にも並べない
  assert.equal((html.match(/URL をコピー/g) ?? []).length, 1);
  assert.equal((html.match(/>開く</g) ?? []).length, 1);
});

test("一覧: 受付した 1 件を除いた他の共有物を並べ、開き直したときと同じ情報を出す", () => {
  const other = item({ id: "def456", name: "site", status: "published" });
  const html = render(controller({ items: [item({ status: "published" }), other], activeId: "abc123" }));
  assert.match(html, /この会話の共有物/);
  assert.match(html, />site</, "他の共有物を一覧に出す");
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "他の共有物の URL も出す");
  // 受付した 1 件は結果の欄だけに出る
  assert.equal((html.match(/共有 ID: /g) ?? []).length, 1);
});

test("失敗: BFF の固定文言だけを出し、URL も生の応答も出さない", () => {
  const html = render(
    controller({
      items: [item({ status: "failed", publicUrl: null, lastError: "公開するディレクトリに index.html がありません" })],
      activeId: "abc123",
    }),
  );
  assert.match(html, /公開できませんでした/);
  assert.match(html, /公開するディレクトリに index.html がありません/);
  assert.equal(html.includes("workers.dev/"), false);
  assert.equal(html.includes("URL をコピー"), false);
});

test("受付の拒否: サーバーの文言 (資格情報の未登録) をそのまま出し、一覧は残す", () => {
  const html = render(
    controller({
      items: [item({ status: "published" })],
      error: "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください",
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /設定 → 共有 → 接続 で登録してください/);
  assert.match(html, /公開済み/, "受付の失敗で一覧を消さない");
  assert.ok(actionTag(html, "共有する"), "未登録の案内後も再試行できる");
});

test("一覧の取得失敗: 空と区別して理由を出し、共有するは押せるままにする", () => {
  const html = render(controller({ failed: true }));
  assert.match(html, /共有物の一覧を取得できませんでした。/);
  assert.equal(html.includes("共有物はまだありません"), false);
  assert.equal(actionTag(html, "共有する").includes("disabled"), false);
});
