// 設定 → 共有 → 接続 の描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 登録状態・トークンの write-only 表示・master key 不在時の無効化を固定する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { CloudflareSettings } from "../src/hooks/useCloudflareSettings";
import type { SharedContentExclusionsSettings } from "../src/hooks/useSharedContentExclusions";
import type { SharedContentsManager } from "../src/hooks/useSharedContentsManager";
import { MEMORY_NOTE } from "../src/lib/settingsNotes";
import type { SharingSubsection } from "../src/lib/settingsNav";
import type {
  CloudflareConnectionCheckResponse,
  CloudflareSettingsResponse,
  SharedContentResponse,
} from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
// 共有コンテンツのタブは useViewportWidth が初回描画で window.innerWidth を読む
globalThis.window ??= {
  innerWidth: 1024,
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Window & typeof globalThis;
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

function exclusions(overrides: Partial<SharedContentExclusionsSettings> = {}): SharedContentExclusionsSettings {
  return {
    settings: {
      excludeNames: ["AGENTS.md"],
      defaultExcludeNames: ["AGENTS.md"],
      overridden: false,
      maxNames: 100,
      maxNameLength: 200,
    },
    draft: { excludeNames: ["AGENTS.md"] },
    dirty: false,
    saving: false,
    reloading: false,
    note: { text: MEMORY_NOTE, error: false },
    add: () => true,
    remove: () => {},
    reload: async () => {},
    save: async () => true,
    reset: async () => true,
    discard: () => {},
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
    bulkStop: null,
    reload: async () => {},
    update: async () => {},
    retry: async () => {},
    stop: async () => {},
    resume: async () => {},
    rename: async () => {},
    remove: async () => {},
    stopAll: async () => {},
    ...overrides,
  };
}

/** 一括停止の対象・対象外を作るための最小の共有物。既定は公開実績のある公開済み */
function contentItem(overrides: Partial<SharedContentResponse> = {}): SharedContentResponse {
  return {
    id: "a",
    sessionId: "s1",
    name: "site",
    sourcePath: "dist",
    sourceKind: "directory",
    provider: "cloudflare",
    status: "published",
    publicUrl: "https://site.account.workers.dev/",
    createdAt: 1,
    updatedAt: 1,
    publishedAt: 1_000,
    stoppedAt: null,
    lastError: null,
    ...overrides,
  };
}

function render(
  value: CloudflareSettings,
  contentsOverrides: Partial<SharedContentsManager> = {},
  sharingSubsection: SharingSubsection = "connections",
): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(SharingSettingsView, {
        cloudflare: value,
        contents: contents(contentsOverrides),
        sharedContentExclusions: exclusions(),
        onOpenArchiveExclusions: () => {},
        sessions: [],
        sessionsLoaded: false,
        sharingSubsection,
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

function stopAllButton(html: string): string {
  return html.match(/<button[^>]*aria-label="[^"]*停止[^"]*"[^>]*>/)?.[0] ?? "";
}

test("共有コンテンツ: 一括停止は稼働中の件数を出し、押せる状態にする", () => {
  const html = render(
    cloudflare(),
    {
      items: [
        contentItem({ id: "a", name: "portfolio" }),
        contentItem({ id: "b", name: "lp" }),
        contentItem({ id: "c", name: "old", status: "stopped" }),
      ],
    },
    "contents",
  );

  assert.ok(html.includes('aria-label="稼働中の共有物 2 件をすべて停止"'), "稼働中の 2 件を数える");
  assert.ok(html.includes("すべて停止"));
  assert.equal(stopAllButton(html).includes("disabled"), false);
});

test("共有コンテンツ: 対象が 0 件なら一括停止を出さない", () => {
  const html = render(
    cloudflare(),
    { items: [contentItem({ status: "stopped" }), contentItem({ id: "b", publishedAt: null })] },
    "contents",
  );
  assert.equal(html.includes("すべて停止"), false);
});

test("共有コンテンツ: 一括停止中は進捗を出し、ボタンと一覧の操作を止める", () => {
  const html = render(
    cloudflare(),
    {
      items: [contentItem({ id: "a", name: "portfolio" }), contentItem({ id: "b", name: "lp" })],
      busy: [{ id: "b", kind: "stop" }],
      bulkStop: { total: 2, done: 1, failures: [], excluded: 0, running: true },
    },
    "contents",
  );

  assert.match(html, /停止中 1\/2/);
  assert.ok(stopAllButton(html).includes("disabled"), "二重実行させない");
  assert.match(html, /role="status"/);
  assert.equal(html.includes("その他の操作"), false, "一括停止中は ⋯ を出さない");
});

test("共有コンテンツ: 一括停止の結果をノートに出し、失敗は danger のトーンにする", () => {
  const success = render(
    cloudflare(),
    {
      items: [contentItem({ status: "stopped" })],
      bulkStop: { total: 1, done: 1, failures: [], excluded: 1, running: false },
    },
    "contents",
  );
  assert.match(success, /稼働中 1 件をすべて停止しました。/);
  assert.match(success, /公開処理中の 1 件は対象外です。完了すると公開されます。/);

  const partial = render(
    cloudflare(),
    {
      items: [contentItem()],
      bulkStop: {
        total: 2,
        done: 2,
        failures: [{ id: "b", name: "docs", message: "Cloudflare への接続がタイムアウトしました" }],
        excluded: 0,
        running: false,
      },
    },
    "contents",
  );
  assert.match(partial, /2 件中 1 件を停止しました。1 件は停止できませんでした（docs）。/);
  assert.match(partial, /text-danger-text/);
});

test("共有コンテンツ: 複数失敗の理由をそれぞれのカードに出す", () => {
  const html = render(
    cloudflare(),
    {
      items: [contentItem({ id: "a", name: "portfolio" }), contentItem({ id: "b", name: "lp" })],
      bulkStop: {
        total: 2,
        done: 2,
        failures: [
          { id: "a", name: "portfolio", message: "Cloudflare への接続がタイムアウトしました" },
          { id: "b", name: "lp", message: "資格情報が一致しません" },
        ],
        excluded: 0,
        running: false,
      },
    },
    "contents",
  );
  assert.match(html, /Cloudflare への接続がタイムアウトしました/);
  assert.match(html, /資格情報が一致しません/);
  assert.match(html, /2 件を停止できませんでした（portfolio、lp）。理由は各カードに表示しています。/);
});

test("共有コンテンツ: 一覧の取得に失敗している間は一括停止を押せない", () => {
  const html = render(
    cloudflare(),
    {
      items: [contentItem()],
      failed: true,
      listError: "共有物の一覧を取得できませんでした",
    },
    "contents",
  );
  assert.ok(stopAllButton(html).includes("disabled"));
  assert.ok(stopAllButton(html).includes("停止する対象を確定できません"));
});

test("共有コンテンツ: Cloudflare 未登録では一括停止を押せない", () => {
  const html = render(
    cloudflare({ settings: settings({ configured: false, accountId: null }) }),
    { items: [contentItem()] },
    "contents",
  );
  assert.ok(stopAllButton(html).includes("disabled"));
  assert.ok(stopAllButton(html).includes("Cloudflare の資格情報が未登録です"));
});
