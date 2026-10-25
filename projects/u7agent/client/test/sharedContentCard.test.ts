// 管理一覧の共有物カードの描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// URL・コピー・補足文・主操作の出し分けを固定する（停止中の URL は公開実績がある行だけ）。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { SHARED_CONTENT_SESSION_MISSING_NOTE, SHARED_CONTENT_UNDEPLOYED_NOTE } from "../src/lib/sharedContents";
import type { SharedContentResponse } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { SharedContentCard } = await import("../src/components/sharing-settings/SharedContentCard");

const URL_PUBLISHED = "https://u7s-abc123.demo.workers.dev/";
/** 公開が一度でも成功した時刻。`publishedAt` が無い published / stopped は未デプロイ（要更新） */
const PUBLISHED_AT = 1_000;

/** 既定は正常な公開済み。未デプロイは `publishedAt: null` を明示する */
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

function render(content: SharedContentResponse, { narrow = false, sessionMissing = false } = {}): string {
  return renderToStaticMarkup(
    createElement(SharedContentCard, {
      item: content,
      narrow,
      sessionMissing,
      session: undefined,
      busy: null,
      error: undefined,
      copied: false,
      copyFailure: undefined,
      onCopy: () => {},
      onUpdate: () => {},
      onStop: () => {},
      onResume: () => {},
      onRetry: () => {},
      onDelete: () => {},
    }),
  );
}

/** ボタンのラベル。狭い面の ⋯ (アイコンだけ) は空文字で並ぶ */
function buttonLabels(html: string): string[] {
  return (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).map((markup) => markup.replace(/<[^>]*>/g, "").trim());
}

/** 最初に一致したボタンの開始タグ。主操作は ⋯ の中身より前に描かれる */
function buttonTag(html: string, label: string): string {
  const button = (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find(
    (markup) => markup.replace(/<[^>]*>/g, "").trim() === label,
  );
  assert.ok(button, `${label} ボタンが無い`);
  return button.slice(0, button.indexOf(">") + 1);
}

test("公開済み: URL と開く / URL コピー / 更新 / 停止 / 削除を出し、要更新の補足は出さない", () => {
  const html = render(item());
  assert.match(html, /公開済み/);
  assert.ok(html.includes(URL_PUBLISHED), "URL を出す");
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "開くは外部リンクとして出す");
  assert.deepEqual(buttonLabels(html), ["URL をコピー", "更新", "停止", "削除"]);
  assert.equal(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE), false);
});

test("未デプロイの公開済み: URL と 開く / コピー / 停止 を出さず、更新 / 削除だけにする", () => {
  const html = render(item({ publishedAt: null, lastError: "Worker の作成に失敗しました" }));
  assert.match(html, /要更新/);
  assert.ok(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE), "更新へ案内する");
  assert.equal(html.includes("公開済み"), false, "実体が無いのに公開済みと言わない");
  assert.equal(html.includes("workers.dev/"), false, "URL を出さない");
  assert.equal(html.includes(">開く<"), false);
  assert.equal(html.includes("URL をコピー"), false);
  assert.deepEqual(buttonLabels(html), ["更新", "削除"]);
  // 最後の失敗理由は固定文言とは別行で添える（判定には使わない）
  assert.match(html, /Worker の作成に失敗しました/);
});

test("未デプロイの停止中: 再公開を出さず、更新と削除だけにする", () => {
  const html = render(item({ status: "stopped", publishedAt: null }));
  assert.match(html, /要更新/);
  assert.equal(html.includes("停止中"), false);
  assert.equal(html.includes("再公開"), false);
  assert.equal(html.includes(">停止<"), false);
  assert.deepEqual(buttonLabels(html), ["更新", "削除"]);
});

test("正常な停止中: URL は残し、開く / コピーは出さず、再公開 / 削除を出す", () => {
  const html = render(item({ status: "stopped", stoppedAt: 2_000 }));
  assert.match(html, /停止中/);
  assert.ok(html.includes(URL_PUBLISHED), "停止中でも URL は残す");
  assert.equal(html.includes(`href="${URL_PUBLISHED}"`), false, "停止中は開かせない");
  assert.equal(html.includes("URL をコピー"), false, "停止中はコピーさせない");
  assert.deepEqual(buttonLabels(html), ["再公開", "削除"]);
  assert.equal(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE), false);
});

test("狭い面の公開済み: 主操作は開くで、コピーを並べる", () => {
  const html = render(item(), { narrow: true });
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "主操作の開くをリンクで出す");
  assert.ok(buttonLabels(html).includes("URL をコピー"));
  assert.ok(html.includes("のその他の操作"), "停止と削除は ⋯ に入れる");
});

test("狭い面の未デプロイ: 主操作を更新にし、URL コピーを出さない", () => {
  const html = render(item({ status: "stopped", publishedAt: null }), { narrow: true });
  assert.ok(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE));
  assert.equal(html.includes("URL をコピー"), false);
  assert.equal(html.includes(">再公開<"), false);
  assert.equal(buttonTag(html, "更新").includes("disabled"), false, "セッションが生きていれば押せる");
});

test("狭い面のセッション削除済みの更新: disabled と、押せない理由を出す", () => {
  const html = render(item({ status: "stopped", publishedAt: null }), { narrow: true, sessionMissing: true });
  const primary = buttonTag(html, "更新");
  assert.equal(primary.includes("disabled"), true);
  assert.ok(primary.includes(`title="${SHARED_CONTENT_SESSION_MISSING_NOTE}"`), "できない理由を出す");
});

test("失敗: 理由を出し、URL と開く / コピーは出さない", () => {
  const html = render(
    item({ status: "failed", publicUrl: null, publishedAt: null, lastError: "index.html がありません" }),
  );
  assert.match(html, /公開できませんでした/);
  assert.match(html, /index\.html がありません/);
  assert.equal(html.includes("workers.dev/"), false);
  assert.equal(html.includes("URL をコピー"), false);
  assert.deepEqual(buttonLabels(html), ["公開を再試行", "削除"]);
});

test("結果不明: 理由を補足に出し、停止だけを出す", () => {
  const html = render(item({ status: "publishing", publishedAt: null, lastError: "公開の結果を確認できませんでした" }));
  assert.match(html, /結果不明/);
  assert.match(html, /公開の結果を確認できませんでした/);
  assert.deepEqual(buttonLabels(html), ["停止"]);
});

test("公開中: URL を出さず、完了したら表示することを添える", () => {
  const html = render(item({ status: "publishing", publishedAt: null }));
  assert.match(html, /公開中/);
  assert.equal(html.includes("workers.dev/"), false);
  assert.match(html, /公開が完了すると URL を表示します/);
  assert.deepEqual(buttonLabels(html), []);
});
