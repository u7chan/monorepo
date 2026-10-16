// 設定 → 通知のページ描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 常設する再読み込みと、未保存の変更がある間だけ無効にして理由を出すことを固定する
// (カードの文言と下書きの規則は notifications.test.ts が担う)。

import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { Notifications } from "../src/hooks/useNotifications";
import { draftFromSettings, type NotificationDraft } from "../src/lib/notifications";
import { MEMORY_NOTE, RELOAD_ABOVE_NOTE, UNSAVED_RELOAD_NOTE } from "../src/lib/settingsNotes";
import type { NotificationsResponse } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { NotificationSettingsPage } = await import("../src/components/NotificationSettingsPage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

const SETTINGS: NotificationsResponse = {
  enabled: true,
  askUser: true,
  provider: "discord",
  configured: true,
  webhookHint: "a1b2",
  baseUrl: "http://localhost:5173",
};

function notifications(overrides: Partial<Notifications> = {}): Notifications {
  const draft: NotificationDraft = draftFromSettings(SETTINGS);
  return {
    settings: SETTINGS,
    draft,
    setDraft: () => {},
    dirty: false,
    saving: false,
    testing: false,
    note: { text: MEMORY_NOTE, error: false },
    reload: async () => {},
    save: async () => true,
    test: async () => null,
    discard: () => {},
    ...overrides,
  };
}

function render(value: Notifications): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(NotificationSettingsPage, { notifications: value, onBack: () => {} }),
    ),
  );
}

/** ラベルでボタンの開始タグを引く (disabled の有無を見るため) */
function actionTag(html: string, label: string): string {
  const button = html
    .match(/<button[^>]*>[\s\S]*?<\/button>/g)
    ?.find((markup) => markup.replace(/<[^>]*>/g, "").trim() === label);
  assert.ok(button, `${label} ボタンが無い`);
  return button.slice(0, button.indexOf(">") + 1);
}

test("描画: ヘッダに再読み込みを常設し、保存群の左に置く", () => {
  const html = render(notifications());
  assert.ok(actionTag(html, "再読み込み"), "再読み込みが無い");
  assert.match(actionTag(html, "再読み込み"), /class="[^"]*btn-quiet/, "取り直しの見た目を揃える");
  assert.ok(html.indexOf("再読み込み") < html.indexOf("破棄"), "再読み込みは保存群の左に置く");
  assert.equal(html.includes(UNSAVED_RELOAD_NOTE), false, "変更が無い間は理由を出さない");
});

test("描画: 未保存の変更がある間は再読み込みを無効にし、理由を 1 行で出す", () => {
  const changed = render(notifications({ dirty: true, draft: { ...draftFromSettings(SETTINGS), enabled: false } }));
  assert.ok(actionTag(changed, "再読み込み").includes("disabled"), "下書きを捨てる再読み込みを押せなくする");
  assert.ok(changed.includes(UNSAVED_RELOAD_NOTE), "押せない理由を出す");
});

test("描画: 読み込みに失敗した枠には再読み込みを置かず、上の導線へ案内する", () => {
  const html = render(
    notifications({
      settings: null,
      note: { text: "通知の設定を読み込めませんでした。接続できません", error: true },
    }),
  );
  assert.ok(html.includes("通知の設定を読み込めませんでした。"), "失敗の理由を出す");
  assert.ok(html.includes(RELOAD_ABOVE_NOTE), "上の [再読み込み] を案内する");
  assert.equal((html.match(/>再読み込み<\/button>/g) ?? []).length, 1, "再読み込みはヘッダに 1 つだけ");
  assert.equal(actionTag(html, "再読み込み").includes("disabled"), false, "未編集では押せる");
});
