// 設定 → ランタイムの初期描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 実行環境 / 利用可能なコマンドのセクションが接続状態・モデル解決と並んで出ることを固定する
// (取得後の状態は lib/runtimeEnvironment の純関数テストが担う)。
// 表示専用の画面なので、編集するプロバイダー認証とカタログは出さない (設定 → モデルへ移設)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Health } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { RuntimePage } = await import("../src/components/RuntimePage");

const HEALTH: Health = {
  ready: true,
  cwd: "/workspace",
  model: "stub/model",
  sandboxConfigured: true,
  runtimeDiagnostics: {
    status: "available",
    catalogCount: 1,
    whitelistCount: 1,
    availableCount: 1,
    versions: { piCodingAgent: "0.87.1" },
  },
};

function renderPage(health: Health | null): string {
  return renderToStaticMarkup(
    createElement(RuntimePage, {
      health,
      onRefreshHealth: async () => health,
      onBack: () => {},
    }),
  );
}

test("renders the connection, environment, commands and model sections in order", () => {
  const html = renderPage(HEALTH);
  const headings = ["接続状態</h3>", "実行環境（サンドボックス側）", "利用可能なコマンド", "モデル解決</h3>"];
  const positions = headings.map((heading) => html.indexOf(heading));
  assert.equal(
    positions.every((position) => position >= 0),
    true,
    `見出しが出る: ${headings.join(" / ")}`,
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "接続状態 → 実行環境 → 利用可能なコマンド → モデル解決 の順に出す",
  );
  assert.ok(html.includes("利用可能"), "health の ready を出す");
  assert.ok(html.includes("設定済み"), "sandboxConfigured を出す");
  assert.ok(html.includes("実行環境を取得しています。"), "取得中の状態を出す");
  assert.ok(html.includes("再読み込み"), "再読み込みボタンを出す");
  assert.ok(html.includes("disabled"), "取得が settled するまでボタンを処理中にする");
  assert.ok(!html.includes("プロバイダーとカタログ"), "カタログは設定 → モデルへ移設した");
  assert.ok(!html.includes("APIキーを保存"), "この画面は表示専用 (認証変更の操作を出さない)");
});

test("renders without a health snapshot", () => {
  const html = renderPage(null);
  assert.ok(html.includes("情報なし"));
  assert.ok(html.includes("実行環境（サンドボックス側）"));
});
