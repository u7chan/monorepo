// 設定 → ランタイムのタブ。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// アクティブな面だけが出ること、タブ行の aria-selected と既定タブを固定する
// (取得後の状態とコピー本文は lib/runtimeEnvironment の純関数テストが担う)。
// 環境タブの取得後の行・コピーボタン・失敗表示は、Effect を実行しない静的描画でも確かめられるよう
// 表示側 (`EnvironmentView`) を直接描いて固定する。実機のクリップボードとキーボード操作は GUI 受入で見る。
// プロバイダー認証とカタログは出さない (設定 → モデルが持つ)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { RuntimeSubsection } from "../src/lib/settingsNav";
import type { RuntimeFetchState } from "../src/lib/runtimeEnvironment";
import type { Health, RuntimeEnvironmentResponse, RuntimeInUseResponse } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { RuntimePage } = await import("../src/components/RuntimePage");
const { EnvironmentView } = await import("../src/components/runtime-settings/EnvironmentTab");
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

test("環境タブは接続状態・利用中のモデル・外部連携・実行環境・利用可能なコマンドをこの順で出す", () => {
  const html = renderPage(HEALTH, "environment");
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*>環境</, "選択中のタブを示す");
  const headings = [
    "接続状態</h3>",
    "利用中のモデル</h3>",
    "外部連携</h3>",
    "実行環境（サンドボックス側）",
    "利用可能なコマンド</h3>",
  ];
  const positions = headings.map((heading) => html.indexOf(heading));
  assert.equal(
    positions.every((position) => position >= 0),
    true,
    `見出しが出る: ${headings.join(" / ")}`,
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    "接続状態 → 利用中のモデル → 外部連携 → 実行環境 → 利用可能なコマンド の順に出す",
  );
  assert.ok(html.includes("利用可能"), "health の ready を出す");
  assert.ok(html.includes("設定済み"), "sandboxConfigured を出す");
  assert.ok(html.includes("利用中のモデルを取得しています。"), "利用中のモデルの取得中を出す");
  assert.ok(html.includes("外部連携を取得しています。"), "外部連携の取得中を出す");
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

const IN_USE: RuntimeInUseResponse = {
  title: {
    enabled: true,
    model: "openai/gpt-6-luna",
    thinkingLevel: "low",
    effectiveThinkingLevel: "high",
    modelAvailable: true,
  },
  content: {
    configured: true,
    enabled: true,
    keyAvailable: true,
    imageModel: "openai/gpt-image-2",
    speechModel: "google/gemini-3.8-flash-tts",
    speechVoice: "Kore",
    bgmModel: "google/lyria-3-clip-preview",
  },
  webSearch: { enabled: true, provider: "tavily", host: "api.tavily.com" },
  cloudflare: { configured: true, available: true, accountId: "0123456789abcdef0123456789abcdef" },
};

const ENVIRONMENT: RuntimeEnvironmentResponse = {
  state: "connected",
  environment: { os: "Debian", arch: "x86_64", user: "node", isRoot: false, workspace: "/workspace" },
  commands: [{ name: "curl", version: "8.14.1" }],
  landlock: { state: "unavailable", abi: null, minAbi: 3, reason: "wrapper_missing" },
};

function renderEnvironmentView(input: {
  health?: Health | null;
  healthFailed?: boolean;
  inUse: RuntimeFetchState<RuntimeInUseResponse>;
  environment: RuntimeFetchState<RuntimeEnvironmentResponse>;
}): string {
  return renderToStaticMarkup(
    createElement(EnvironmentView, {
      health: input.health === undefined ? HEALTH : input.health,
      healthFailed: input.healthFailed ?? false,
      inUse: input.inUse,
      environment: input.environment,
      pending: false,
      onReload: () => {},
      runtimeSubsection: "environment",
      onBack: () => {},
    }),
  );
}

test("取得後の環境タブは利用中のモデルと外部連携の行を出し、識別子ごとにコピーを置く", () => {
  const html = renderEnvironmentView({
    inUse: { status: "ready", value: IN_USE },
    environment: { status: "ready", value: ENVIRONMENT },
  });

  // 既定モデルは接続状態ではなく「利用中のモデル」の先頭に出す
  const connection = html.indexOf("接続状態</h3>");
  const models = html.indexOf("利用中のモデル</h3>");
  const defaultModel = html.indexOf("既定モデル");
  assert.ok(connection >= 0 && models > connection && defaultModel > models, "既定モデルを接続状態の後ろへ移す");
  assert.ok(html.includes("openai/gpt-6-luna"), "既定モデルのIDを出す");
  assert.ok(html.includes("Effort: high"), "会話タイトルは実効 Effort を出す");
  assert.ok(html.includes("ボイス: Kore"), "音声のボイスを注記に出す");
  assert.ok(html.includes("api.tavily.com · 有効"), "Web 検索の host と状態を出す");
  assert.ok(html.includes("0123456789abcdef0123456789abcdef"), "Cloudflare のアカウントIDを出す");

  for (const label of [
    "既定モデルのIDをコピー",
    "会話タイトルのモデルIDをコピー",
    "画像生成モデルのIDをコピー",
    "音声モデルのIDをコピー",
    "BGM モデルのIDをコピー",
    "音声のボイスをコピー",
    "Web 検索の provider ID をコピー",
    "Cloudflare のアカウントIDをコピー",
  ]) {
    assert.ok(html.includes(`aria-label="${label}"`), `コピーボタン「${label}」を出す`);
  }
  assert.equal(html.includes("利用中のモデルを取得しています。"), false, "取得後は取得中の文言を出さない");
  assert.equal(html.includes("接続情報をコピー"), true, "一括コピーは残す");
});

test("音声の指定なしは注記だけで、コピーボタンを出さない", () => {
  const html = renderEnvironmentView({
    inUse: {
      status: "ready",
      value: { ...IN_USE, content: { ...IN_USE.content, speechVoice: null } },
    },
    environment: { status: "ready", value: ENVIRONMENT },
  });

  assert.ok(html.includes("ボイス: 指定なし"));
  assert.equal(html.includes('aria-label="音声のボイスをコピー"'), false, "指定なしをコピーさせない");
});

test("未取得の既定モデルを未設定と書かず、行を残す", () => {
  const html = renderEnvironmentView({
    health: null,
    inUse: { status: "ready", value: IN_USE },
    environment: { status: "ready", value: ENVIRONMENT },
  });

  assert.ok(html.includes("既定モデル"));
  assert.ok(html.includes("情報なし"));
  assert.equal(html.includes('aria-label="既定モデルのIDをコピー"'), false, "値が無いのでコピーしない");
});

test("取得できていない間は 2 カードに取得中の文言を出す", () => {
  const html = renderEnvironmentView({ inUse: { status: "loading" }, environment: { status: "loading" } });

  assert.ok(html.includes("利用中のモデルを取得しています。"));
  assert.ok(html.includes("外部連携を取得しています。"));
  assert.equal(html.includes('aria-label="既定モデルのIDをコピー"'), false, "取得前は行を出さない");
});

test("取得失敗は 2 カードに閉じ、実行環境のカードは表示する", () => {
  const html = renderEnvironmentView({
    inUse: { status: "error", message: "アプリデータ（SQLite）を利用できません" },
    environment: { status: "ready", value: ENVIRONMENT },
  });

  assert.ok(html.includes("利用中のモデルを取得できませんでした。"));
  assert.ok(html.includes("アプリデータ（SQLite）を利用できません"), "モデル側に理由を出す");
  assert.ok(html.includes("外部連携は表示していません。"), "外部連携側は非表示の理由を出す");
  assert.ok(html.includes("実行環境（サンドボックス側）"));
  assert.ok(html.includes("Debian"), "実行環境のカードは巻き込まない");
  assert.ok(html.includes("- 接続状態") === false, "行の記法はコピー本文だけに使う");
});

test("health の再取得失敗は既定モデル側にだけ断り書きを出す", () => {
  const html = renderEnvironmentView({
    inUse: { status: "ready", value: IN_USE },
    environment: { status: "ready", value: ENVIRONMENT },
    healthFailed: true,
  });

  assert.ok(html.includes("接続状態を再取得できませんでした。前回の値を表示しています。"));
  assert.ok(html.includes("openai/gpt-6-luna"), "前回値の行は残す");
});
