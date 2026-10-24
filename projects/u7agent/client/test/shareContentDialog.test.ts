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
    preview: { status: "loading" },
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

test("一覧: 受付した 1 件を除いた他の共有物を並べ、共有 ID も出す", () => {
  const other = item({ id: "def456", name: "site", status: "published" });
  const html = render(controller({ items: [item({ status: "published" }), other], activeId: "abc123" }));
  assert.match(html, /この会話の共有物/);
  assert.match(html, />site</, "他の共有物を一覧に出す");
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "他の共有物の URL も出す");
  assert.ok(html.includes(">def456<"), "一覧の共有物にも共有 ID を出す");
});

test("再オープン: 受付していない状態でも一覧の各共有物に共有 ID と URL を出す", () => {
  const published = item({ status: "published" });
  // failed は URL が無く、同じディレクトリの再公開では名前が重なる。ID が無いと見分けられない
  const failed = item({ id: "def456", status: "failed", publicUrl: null, lastError: "index.html がありません" });
  const html = render(controller({ items: [published, failed] }));
  assert.equal((html.match(/共有 ID: /g) ?? []).length, 2, "一覧の全件に共有 ID を出す");
  assert.ok(html.includes(">abc123<"));
  assert.ok(html.includes(">def456<"));
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "公開済みの URL は開き直しでも出す");
  assert.match(html, /公開できませんでした/);
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

// プレビューは補助。取得できなくても公開の確定を塞がないことを、ボタンの状態で固定する
test("プレビュー取得中: 確認中を示し、公開の操作は行える", () => {
  const html = render(controller());
  assert.match(html, /公開される内容/);
  assert.match(html, /確認しています/);
  assert.equal(actionTag(html, "共有する").includes("disabled"), false);
});

test("プレビュー失敗: 文言をそのまま出し、共有はできると添えて公開を塞がない", () => {
  const html = render(controller({ preview: { status: "failed", message: "公開するディレクトリが見つかりません" } }));
  assert.match(html, /公開するディレクトリが見つかりません/);
  assert.match(html, /プレビューは取得できませんでしたが、共有はできます。/);
  assert.equal(actionTag(html, "共有する").includes("disabled"), false);
});

test("プレビュー: 件数（ディレクトリを含む）・合計サイズ・一覧・問題を出し、ファイル数とは書かない", () => {
  const html = render(
    controller({
      preview: {
        status: "ready",
        preview: {
          sourcePath: "projects/app/dist",
          entries: 1200,
          bytes: 2048,
          files: [
            { name: "index.html", size: 512 },
            { name: "assets/app.js", size: 1536 },
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
        },
      },
    }),
  );
  assert.match(html, /1,200 件（ディレクトリを含む）・合計 2 KB/);
  assert.match(html, /index\.html/);
  assert.match(html, /assets\/app\.js/);
  assert.equal(html.includes("ファイル数"), false, "件数はディレクトリも数える");
  assert.match(html, /公開されるものは公開時に検証し直します/);
});

test("プレビュー: 問題と、公開されないもの・打ち切りを出す", () => {
  const html = render(
    controller({
      preview: {
        status: "ready",
        preview: {
          sourcePath: "projects/app/dist",
          entries: 900,
          bytes: 10,
          files: [{ name: "app.js", size: 10 }],
          truncated: true,
          links: ["secret-link.txt"],
          linksTruncated: false,
          oversizeFiles: ["video.mp4"],
          oversizeTruncated: false,
          hasIndexHtml: false,
          skipped: [],
          excludeNames: [],
          limited: false,
          problems: ["公開するディレクトリに index.html がありません"],
        },
      },
    }),
  );
  assert.match(html, /公開するディレクトリに index\.html がありません/);
  assert.match(html, /symlink など公開されないもの: secret-link\.txt/);
  assert.match(html, /一覧は先頭 1 件までしか取得できていません。/);
});

test("プレビュー: 上限超過 (limited) は件数と index.html の有無を出さず、問題だけを出す", () => {
  const html = render(
    controller({
      preview: {
        status: "ready",
        preview: {
          sourcePath: "projects/app/dist",
          entries: null,
          bytes: null,
          files: [],
          truncated: false,
          links: [],
          linksTruncated: false,
          oversizeFiles: [],
          oversizeTruncated: false,
          hasIndexHtml: null,
          skipped: [],
          excludeNames: [],
          limited: true,
          problems: ["公開するファイルが多すぎます（最大 10,000 件）"],
        },
      },
    }),
  );
  assert.match(html, /公開するファイルが多すぎます（最大 10,000 件）/);
  assert.match(html, /上限を超えているため、一覧と index\.html の有無を確認できませんでした。/);
  assert.equal(html.includes("index.html がありません"), false, "判定できない不在を出さない");
  assert.equal(actionTag(html, "共有する").includes("disabled"), false);
});
