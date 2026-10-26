// 管理一覧の共有物カードの描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// URL・コピー・メタ情報・操作の出し分けを固定する（停止中の URL は公開実績がある行だけ。
// 名前を変更と破壊的な操作は ⋯ に集約し、行には状態ごとの主操作だけを並べる）。
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
      onRename: () => {},
      onUpdate: () => {},
      onStop: () => {},
      onResume: () => {},
      onRetry: () => {},
      onDelete: () => {},
    }),
  );
}

function buttonMarkup(html: string): string[] {
  return html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

/** ボタンのラベル。アイコンだけのボタン (⋯ と URL コピー) は空文字で並ぶ */
function buttonLabels(html: string): string[] {
  return buttonMarkup(html).map((markup) => markup.replace(/<[^>]*>/g, "").trim());
}

/**
 * ⋯ の popover。静的描画でも DOM に残るので、行の操作と混ぜずに数える。
 * `popover="auto"` の div を、入れ子の div を数えて閉じ位置まで切り出す。
 */
function menuHtml(html: string): string {
  return divBlock(html, 'popover="auto"');
}

/** 指定の属性を持つ div を、入れ子を数えて閉じタグまで切り出す */
function divBlock(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at === -1) return "";
  const start = html.lastIndexOf("<div", at);
  let depth = 1;
  let index = start + 4;
  while (index < html.length) {
    const open = html.indexOf("<div", index);
    const close = html.indexOf("</div>", index);
    if (close === -1) break;
    if (open !== -1 && open < close) {
      depth += 1;
      index = open + 4;
    } else {
      depth -= 1;
      index = close + 6;
      if (depth === 0) return html.slice(start, index);
    }
  }
  return "";
}

/** 行に並ぶ操作 (リンクも含む)。⋯ の中身とは分けて数える */
function rowLabels(html: string): string[] {
  const row = divBlock(html, 'aria-label="共有物の操作"');
  return (row.match(/<(?:button|a)[^>]*>[\s\S]*?<\/(?:button|a)>/g) ?? []).map((markup) =>
    markup.replace(/<[^>]*>/g, "").trim(),
  );
}

function menuLabels(html: string): string[] {
  return buttonLabels(menuHtml(html));
}

/** 最初に一致したボタンの開始タグ。主操作は ⋯ の中身より前に描かれる */
function buttonTag(html: string, label: string): string {
  const button = buttonMarkup(html).find((markup) => markup.replace(/<[^>]*>/g, "").trim() === label);
  assert.ok(button, `${label} ボタンが無い`);
  return button.slice(0, button.indexOf(">") + 1);
}

test("公開済み: URL バーにコピーを置き、行は開く / 更新、⋯ に名前を変更 / 停止 / 削除を出す", () => {
  const html = render(item());
  assert.match(html, /公開済み/);
  assert.ok(html.includes(URL_PUBLISHED), "URL を出す");
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "開くは外部リンクとして出す");
  assert.ok(html.includes('aria-label="URL をコピー"'), "コピーは URL の右端のアイコンボタン");
  assert.deepEqual(rowLabels(html), ["開く", "更新"]);
  assert.deepEqual(menuLabels(html), ["名前を変更", "停止", "削除"]);
  assert.equal(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE), false);
});

test("公開済みの ⋯: 名前の変更が先頭で、破壊的な削除は最後に置く", () => {
  const labels = menuLabels(render(item()));
  assert.equal(labels[0], "名前を変更");
  assert.equal(labels.at(-1), "削除");
});

test("狭い面の公開済み: 主操作は開くだけで、更新も ⋯ に入れる", () => {
  const html = render(item(), { narrow: true });
  assert.ok(html.includes(`href="${URL_PUBLISHED}"`), "主操作の開くをリンクで出す");
  assert.ok(html.includes('aria-label="URL をコピー"'), "コピーは URL バーに残す");
  assert.deepEqual(rowLabels(html), ["開く"]);
  assert.deepEqual(menuLabels(html), ["名前を変更", "更新", "停止", "削除"]);
});

test("コピー成功: アイコンのラベルをコピー済みへ変える", () => {
  const html = renderToStaticMarkup(
    createElement(SharedContentCard, {
      item: item(),
      narrow: false,
      sessionMissing: false,
      session: undefined,
      busy: null,
      error: undefined,
      copied: true,
      copyFailure: undefined,
      onCopy: () => {},
      onRename: () => {},
      onUpdate: () => {},
      onStop: () => {},
      onResume: () => {},
      onRetry: () => {},
      onDelete: () => {},
    }),
  );
  assert.ok(html.includes('aria-label="URL をコピーしました"'));
  assert.equal(html.includes('aria-label="URL をコピー"'), false);
});

test("メタ情報: 公開元・会話・時刻を ・ で区切って 1 行に並べる", () => {
  const html = renderToStaticMarkup(
    createElement(SharedContentCard, {
      item: item(),
      narrow: false,
      sessionMissing: false,
      session: { sessionId: "s1", title: "会話の題", createdAt: 1, updatedAt: 1 } as never,
      busy: null,
      error: undefined,
      copied: false,
      copyFailure: undefined,
      onCopy: () => {},
      onRename: () => {},
      onUpdate: () => {},
      onStop: () => {},
      onResume: () => {},
      onRetry: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(html, /公開元/);
  assert.match(html, /会話の題/);
  assert.match(html, /更新/);
  assert.match(html, /・/);
});

test("未デプロイの公開済み: URL とコピーを出さず、行は更新、⋯ は名前を変更 / 削除にする", () => {
  const html = render(item({ publishedAt: null, lastError: "Worker の作成に失敗しました" }));
  assert.match(html, /要更新/);
  assert.ok(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE), "更新へ案内する");
  assert.equal(html.includes("公開済み"), false, "実体が無いのに公開済みと言わない");
  assert.equal(html.includes("workers.dev/"), false, "URL を出さない");
  assert.equal(html.includes('aria-label="URL をコピー"'), false);
  assert.deepEqual(rowLabels(html), ["更新"]);
  assert.deepEqual(menuLabels(html), ["名前を変更", "削除"]);
  // 最後の失敗理由は固定文言とは別行で添える（判定には使わない）
  assert.match(html, /Worker の作成に失敗しました/);
});

test("未デプロイの停止中: 再公開を出さず、行は更新だけにする", () => {
  const html = render(item({ status: "stopped", publishedAt: null }));
  assert.match(html, /要更新/);
  assert.equal(html.includes("停止中"), false);
  assert.equal(html.includes("再公開"), false);
  assert.deepEqual(rowLabels(html), ["更新"]);
  assert.deepEqual(menuLabels(html), ["名前を変更", "削除"]);
});

test("正常な停止中: URL は淡色の記録として残し、開く / コピーを出さず、再公開を出す", () => {
  const html = render(item({ status: "stopped", stoppedAt: 2_000 }));
  assert.match(html, /停止中/);
  assert.ok(html.includes(URL_PUBLISHED), "停止中でも URL は残す");
  assert.equal(html.includes(`href="${URL_PUBLISHED}"`), false, "停止中は開かせない");
  assert.equal(html.includes('aria-label="URL をコピー"'), false, "停止中はコピーさせない");
  assert.equal(html.includes("bg-raised"), false, "URL バーを出さない（コピーの無いバーを残さない）");
  assert.deepEqual(rowLabels(html), ["再公開"]);
  assert.deepEqual(menuLabels(html), ["名前を変更", "削除"]);
  assert.equal(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE), false);
});

test("狭い面の未デプロイ: 主操作を更新にし、URL コピーを出さない", () => {
  const html = render(item({ status: "stopped", publishedAt: null }), { narrow: true });
  assert.ok(html.includes(SHARED_CONTENT_UNDEPLOYED_NOTE));
  assert.equal(html.includes('aria-label="URL をコピー"'), false);
  assert.equal(html.includes(">再公開<"), false);
  assert.deepEqual(rowLabels(html), ["更新"]);
  assert.equal(buttonTag(html, "更新").includes("disabled"), false, "セッションが生きていれば押せる");
});

test("狭い面のセッション削除済みの更新: disabled と、押せない理由を出す", () => {
  const html = render(item({ status: "stopped", publishedAt: null }), { narrow: true, sessionMissing: true });
  const primary = buttonTag(html, "更新");
  assert.equal(primary.includes("disabled"), true);
  assert.ok(primary.includes(`title="${SHARED_CONTENT_SESSION_MISSING_NOTE}"`), "できない理由を出す");
});

test("失敗: 理由を出し、URL とコピーは出さない", () => {
  const html = render(
    item({ status: "failed", publicUrl: null, publishedAt: null, lastError: "index.html がありません" }),
  );
  assert.match(html, /公開できませんでした/);
  assert.match(html, /index\.html がありません/);
  assert.equal(html.includes("workers.dev/"), false);
  assert.equal(html.includes('aria-label="URL をコピー"'), false);
  assert.deepEqual(rowLabels(html), ["公開を再試行"]);
  assert.deepEqual(menuLabels(html), ["名前を変更", "削除"]);
});

test("結果不明: 理由を補足に出し、停止だけを出す（⋯ は出さない）", () => {
  const html = render(item({ status: "publishing", publishedAt: null, lastError: "公開の結果を確認できませんでした" }));
  assert.match(html, /結果不明/);
  assert.match(html, /公開の結果を確認できませんでした/);
  assert.deepEqual(rowLabels(html), ["停止"]);
  assert.deepEqual(menuLabels(html), []);
  assert.equal(html.includes("のその他の操作"), false);
});

test("公開中: URL を出さず、完了したら表示することを添え、操作も出さない", () => {
  const html = render(item({ status: "publishing", publishedAt: null }));
  assert.match(html, /公開中/);
  assert.equal(html.includes("workers.dev/"), false);
  assert.match(html, /公開が完了すると URL を表示します/);
  assert.deepEqual(rowLabels(html), []);
  assert.deepEqual(menuLabels(html), []);
});

test("コピー失敗: URL を選択してコピーする逃げ道を示す", () => {
  const html = renderToStaticMarkup(
    createElement(SharedContentCard, {
      item: item(),
      narrow: false,
      sessionMissing: false,
      session: undefined,
      busy: null,
      error: undefined,
      copied: false,
      copyFailure: "denied",
      onCopy: () => {},
      onRename: () => {},
      onUpdate: () => {},
      onStop: () => {},
      onResume: () => {},
      onRetry: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(html, /コピーできませんでした。URL を選択してコピーしてください。/);
});
