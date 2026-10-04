// 設定 → ランタイムの初期描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 接続状態 / 実行環境 / 利用可能なコマンドのセクションが出て、モデル解決が撤去されたことを固定する
// (取得後の状態とコピー本文は lib/runtimeEnvironment の純関数テストが担う)。
// プロバイダー認証とカタログは出さない (設定 → モデルが持つ)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Health } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { RuntimePage } = await import("../src/components/RuntimePage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const HEALTH: Health = {
  ready: true,
  cwd: "/workspace",
  model: "stub/model",
  sandboxConfigured: true,
  versions: { piCodingAgent: "0.87.1" },
};

function renderPage(health: Health | null): string {
  return renderToStaticMarkup(
    createElement(ConfirmProvider, {
      children: createElement(RuntimePage, {
        health,
        onRefreshHealth: async () => health,
        onBack: () => {},
      }),
    }),
  );
}

test("renders the connection, environment and command sections in order", () => {
  const html = renderPage(HEALTH);
  assert.ok(html.includes("公開中のサービス</h3>"));
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
  assert.ok(html.includes('aria-label="診断情報をコピー"'), "一括コピーのボタンを出す");
  assert.ok(html.includes("disabled"), "取得が settled するまでボタンを処理中にする");
  assert.ok(html.includes("pi-coding-agent: 0.87.1"), "SDK バージョンは接続状態に残す");
  assert.ok(!html.includes("モデル解決"), "モデル解決は health の診断ごと撤去した");
  assert.ok(!html.includes("PI_MODELS") && !html.includes("PI_MODEL"), "明示モデル / 許可リストの診断を出さない");
  assert.ok(!html.includes("whitelist"), "whitelist の語を出さない");
  assert.ok(!html.includes("プロバイダーとカタログ"), "カタログは設定 → モデルへ移設した");
  assert.ok(!html.includes("APIキーを保存"), "認証変更の操作は出さない");
});

test("renders without a health snapshot", () => {
  const html = renderPage(null);
  assert.ok(html.includes("情報なし"));
  assert.ok(html.includes("実行環境（サンドボックス側）"));
  assert.ok(!html.includes("モデル解決"));
});
