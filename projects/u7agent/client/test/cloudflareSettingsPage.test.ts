// 設定 → 共有 → 接続 の描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 登録状態・トークンの write-only 表示・master key 不在時の無効化を固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { CloudflareSettings } from "../src/hooks/useCloudflareSettings";
import type { SharedContentsManager } from "../src/hooks/useSharedContentsManager";
import { MEMORY_NOTE } from "../src/lib/settingsNotes";
import type { CloudflareConnectionCheckResponse, CloudflareSettingsResponse } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { SharingSettingsView } = await import("../src/components/SharingSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const settings = (overrides: Partial<CloudflareSettingsResponse> = {}): CloudflareSettingsResponse => ({
  configured: true,
  accountId: ACCOUNT,
  available: true,
  unavailableReason: null,
  ...overrides,
});

function cloudflare(overrides: Partial<CloudflareSettings> = {}): CloudflareSettings {
  return {
    settings: settings(),
    note: { text: MEMORY_NOTE, error: false },
    saving: null,
    reloading: false,
    reload: async () => {},
    save: async () => true,
    remove: async () => true,
    checking: false,
    checkResult: null,
    checkError: null,
    check: async () => {},
    ...overrides,
  };
}

function checkResult(overrides: Partial<CloudflareConnectionCheckResponse> = {}): CloudflareConnectionCheckResponse {
  return {
    checkedAt: Date.UTC(2026, 8, 5, 3, 4, 5),
    accountId: ACCOUNT,
    subdomain: null,
    failure: null,
    httpStatus: null,
    message: null,
    ...overrides,
  };
}

function contents(overrides: Partial<SharedContentsManager> = {}): SharedContentsManager {
  return {
    items: [],
    loading: false,
    failed: false,
    listError: null,
    reloading: false,
    busy: [],
    error: null,
    reload: async () => {},
    update: async () => {},
    retry: async () => {},
    stop: async () => {},
    resume: async () => {},
    remove: async () => {},
    ...overrides,
  };
}

function render(value: CloudflareSettings): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(SharingSettingsView, {
        cloudflare: value,
        contents: contents(),
        sessions: [],
        sessionsLoaded: false,
        sharingSubsection: "connections",
        onSelectSharingSubsection: () => {},
        onBack: () => {},
      }),
    ),
  );
}

function actionTag(html: string, label: string): string {
  const button = html
    .match(/<button[^>]*>[\s\S]*?<\/button>/g)
    ?.find((markup) => markup.replace(/<[^>]*>/g, "").trim() === label);
  assert.ok(button, `${label} ボタンが無い`);
  return button.slice(0, button.indexOf(">") + 1);
}

test("描画: 接続タブと Cloudflare カードを出し、登録済みアカウントと write-only のトークン欄を表示する", () => {
  const html = render(cloudflare());
  assert.match(html, />接続</);
  assert.match(html, /CLOUDFLARE/);
  assert.match(html, /登録済み/);
  assert.ok(html.includes(`value="${ACCOUNT}"`), "保存済みアカウント ID を表示する");
  assert.match(html, /type="password"/);
  assert.match(html, /保存済み（変更するときだけ入力）/);
  assert.ok(actionTag(html, "削除"), "登録済みなら削除を出す");
  assert.ok(actionTag(html, "保存").includes("disabled"), "変更が無い間は保存できない");
});

test("描画: 未登録では削除を出さず、トークンが入るまで保存できない", () => {
  const html = render(cloudflare({ settings: settings({ configured: false, accountId: null }) }));
  assert.match(html, /未登録/);
  assert.equal(html.includes(">削除<"), false);
  assert.ok(actionTag(html, "保存").includes("disabled"));
  assert.match(html, /Cloudflare の API トークン/);
});

test("描画: master key が使えないときは理由を出し、入力と保存を無効にする", () => {
  const html = render(
    cloudflare({
      settings: settings({
        configured: false,
        accountId: null,
        available: false,
        unavailableReason: "master key が未設定です",
      }),
    }),
  );
  assert.match(html, /master key が未設定です/);
  assert.ok(actionTag(html, "保存").includes("disabled"));
  assert.equal((html.match(/<input[^>]*disabled/g) ?? []).length, 2, "アカウント ID とトークンの両方を無効にする");
});

test("描画: 保存中はボタンを保存中へ変えて二重送信を防ぐ", () => {
  const html = render(cloudflare({ saving: "save" }));
  assert.match(html, /保存中/);
  assert.ok(actionTag(html, "保存中").includes("disabled"));
});

test("描画: 未登録と master key 不在では「接続を確認」を無効にする", () => {
  const notConfigured = render(cloudflare({ settings: settings({ configured: false, accountId: null }) }));
  assert.ok(actionTag(notConfigured, "接続を確認").includes("disabled"), "未登録では押せない");

  const unavailable = render(
    cloudflare({
      settings: settings({ configured: true, available: false, unavailableReason: "master key が未設定です" }),
    }),
  );
  assert.ok(actionTag(unavailable, "接続を確認").includes("disabled"), "master key 不在では押せない");
  assert.match(unavailable, /master key が未設定です/);
});

test('描画: 確認中はボタンを確認中へ変え、role="status" に進行中を出す', () => {
  const html = render(cloudflare({ checking: true }));
  assert.ok(actionTag(html, "確認中").includes("disabled"));
  assert.match(html, /role="status"/);
  assert.match(html, /接続を確認しています/);
});

test('描画: 成功は workers.dev サブドメインと確認時刻を role="status" に出し、アカウント ID を重複させない', () => {
  const html = render(cloudflare({ checkResult: checkResult({ subdomain: "demo" }) }));
  assert.match(html, /role="status"/);
  assert.match(html, /demo\.workers\.dev/);
  assert.match(html, /<time[^>]*>[^<]+<\/time>/, "確認時刻を出す");
  assert.equal((html.match(new RegExp(ACCOUNT, "g")) ?? []).length, 1, "アカウント ID は入力欄だけに出す");
});

test("描画: 失敗は固定文言と HTTP status を出し、トークンを載せない", () => {
  const html = render(
    cloudflare({
      checkResult: checkResult({
        failure: "unauthorized",
        httpStatus: 403,
        message: "Cloudflare のアカウント ID または Workers Scripts の権限を確認してください",
      }),
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Workers Scripts の権限/);
  assert.match(html, /HTTP 403/);
  assert.equal(html.includes("cf-"), false);
});

test('描画: 409 / 503 はカード内の結果行に role="alert" で出す', () => {
  const html = render(
    cloudflare({ checkError: "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください" }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /資格情報が未登録/);
  assert.equal(html.includes("接続を確認しています"), false);
});
