// 設定 → ランタイムのタブ。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// アクティブな面だけが出ること、タブ行の aria-selected と既定タブを固定する
// (取得後の状態とコピー本文は lib/runtimeEnvironment の純関数テストが担う)。
// プロバイダー認証とカタログは出さない (設定 → モデルが持つ)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { RuntimeSubsection } from "../src/lib/settingsNav";
import type { Health } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { RuntimePage } = await import("../src/components/RuntimePage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");
const { DiagnosticsContext } = await import("../src/DiagnosticsContext");
const { diagnosticsStub } = await import("./diagnostics-fixture");

const HEALTH: Health = {
  ready: true,
  cwd: "/workspace",
  model: "stub/model",
  sandboxConfigured: true,
  versions: { piCodingAgent: "0.87.1" },
};

function renderPage(health: Health | null, runtimeSubsection?: RuntimeSubsection): string {
  return renderToStaticMarkup(
    createElement(DiagnosticsContext.Provider, {
      value: diagnosticsStub,
      children: createElement(ConfirmProvider, {
        children: createElement(RuntimePage, {
          health,
          runtimeSubsection,
          onRefreshHealth: async () => health,
          onBack: () => {},
          sessions: [],
        }),
      }),
    }),
  );
}

test("タブ行は 3 タブを出し、既定は「サービス」", () => {
  const html = renderPage(HEALTH);
  assert.ok(html.includes('role="tablist"'), "タブ行を出す");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3, "タブは 3 つ");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>サービス</, "既定は「サービス」");
  for (const label of ["サービス", "環境", "診断"]) {
    assert.ok(html.includes(label), `タブ「${label}」を出す`);
  }
});

test("既定タブは公開中のサービスだけを出す", () => {
  const html = renderPage(HEALTH);
  assert.ok(html.includes("公開中のサービス</h3>"), "サービスカードを出す");
  assert.ok(html.includes("再読み込み"), "再読み込みボタンを出す");
  assert.equal(html.includes("接続情報をコピー"), false, "コピーは環境タブに置く");
  assert.equal(html.includes("実行環境を取得しています。"), false, "環境タブの本文を出さない");
  assert.equal(html.includes("セッション診断</h3>"), false, "診断カードを出さない");
});

test("環境タブは接続状態・実行環境・利用可能なコマンドをこの順で出す", () => {
  const html = renderPage(HEALTH, "environment");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>環境</, "選択中のタブを示す");
  const headings = ["接続状態</h3>", "実行環境（サンドボックス側）", "利用可能なコマンド</h3>"];
  const positions = headings.map((heading) => html.indexOf(heading));
  assert.equal(
    positions.every((position) => position >= 0),
    true,
    `見出しが出る: ${headings.join(" / ")}`,
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "接続状態 → 実行環境 → 利用可能なコマンド の順に出す",
  );
  assert.ok(html.includes("利用可能"), "health の ready を出す");
  assert.ok(html.includes("設定済み"), "sandboxConfigured を出す");
  assert.ok(html.includes("実行環境を取得しています。"), "取得中の状態を出す");
  assert.ok(html.includes("再読み込み"), "再読み込みボタンを出す");
  assert.ok(html.includes('aria-label="接続情報をコピー"'), "接続情報の一括コピーのボタンを出す");
  assert.ok(html.includes("disabled"), "取得が settled するまでボタンを処理中にする");
  assert.ok(html.includes("pi-coding-agent: 0.87.1"), "SDK バージョンは接続状態に残す");
  assert.equal(html.includes("公開中のサービス</h3>"), false, "サービスカードを出さない");
  assert.equal(html.includes("セッション診断</h3>"), false, "診断カードを出さない");
  assert.ok(!html.includes("モデル解決"), "モデル解決は health の診断ごと撤去した");
  assert.ok(!html.includes("PI_MODELS") && !html.includes("PI_MODEL"), "明示モデル / 許可リストの診断を出さない");
  assert.ok(!html.includes("whitelist"), "whitelist の語を出さない");
  assert.ok(!html.includes("プロバイダーとカタログ"), "カタログは設定 → モデルへ移設した");
  assert.ok(!html.includes("APIキーを保存"), "認証変更の操作は出さない");
});

test("診断タブはセッション診断カードを出し、面のツールバーには再読み込みだけを置く", () => {
  const html = renderPage(HEALTH, "diagnostics");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>診断</, "選択中のタブを示す");
  assert.ok(html.includes("セッション診断</h3>"), "セッション診断カードを出す");
  assert.equal(html.includes('aria-label="接続情報をコピー"'), false, "面のツールバーにコピーを置かない");
  // カードのヘッダから移した再読み込みはツールバーに 1 つだけ。対象が未選択なので押せない
  assert.equal((html.match(/>再読み込み<\/button>/g) ?? []).length, 1, "再読み込みは面のツールバーに 1 つだけ");
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*再読み込み.*<\/button>/s, "対象を選ぶまで押せない");
  assert.ok(html.includes("対象の会話を選ぶまで取得しません。"), "押せない理由をカード内に出す");
  assert.ok(html.includes("公開中のサービス</h3>") === false, "サービスカードを出さない");
  assert.equal(html.includes("実行環境を取得しています。"), false, "環境タブの本文を出さない");
});

test("health が無くても環境タブは情報なしで描ける", () => {
  const html = renderPage(null, "environment");
  assert.ok(html.includes("情報なし"));
  assert.ok(html.includes("実行環境（サンドボックス側）"));
  assert.ok(!html.includes("モデル解決"));
});
