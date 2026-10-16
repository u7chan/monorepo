// 設定 → 通知のページ描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// ヘッダ直下の帯に常設する再読み込みと、未保存の変更がある間だけ無効にして理由を出すことを固定する
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
    reloading: false,
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

/** ヘッダの終端 (面の操作がヘッダへ戻っていないことを位置で見る) */
function headerEnd(html: string): number {
  const end = html.indexOf("</header>");
  assert.ok(end > 0, "ヘッダが無い");
  return end;
}

test("描画: 面の操作をヘッダ直下の帯へ出し、再読み込みを保存群の左に置く", () => {
  const html = render(notifications());
  assert.ok(actionTag(html, "再読み込み"), "再読み込みが無い");
  assert.match(actionTag(html, "再読み込み"), /class="[^"]*btn-quiet/, "取り直しの見た目を揃える");
  const end = headerEnd(html);
  const reloadAt = html.indexOf(actionTag(html, "再読み込み"));
  const discardAt = html.indexOf(actionTag(html, "破棄"));
  const saveAt = html.indexOf(actionTag(html, "保存"));
  for (const [label, at] of [
    ["再読み込み", reloadAt],
    ["破棄", discardAt],
    ["保存", saveAt],
  ] as const) {
    assert.ok(at > end, `${label} はヘッダの直下の帯に置く`);
  }
  assert.ok(reloadAt < discardAt && discardAt < saveAt, "再読み込み → 破棄 → 保存 の順に並べる");
  assert.equal(html.includes(UNSAVED_RELOAD_NOTE), false, "変更が無い間は理由を出さない");
});

test("描画: 未保存の変更がある間は再読み込みを無効にし、理由をヘッダの説明へ 1 行で出す", () => {
  const changed = render(notifications({ dirty: true, draft: { ...draftFromSettings(SETTINGS), enabled: false } }));
  assert.ok(actionTag(changed, "再読み込み").includes("disabled"), "下書きを捨てる再読み込みを押せなくする");
  assert.ok(changed.slice(0, headerEnd(changed)).includes(UNSAVED_RELOAD_NOTE), "押せない理由はヘッダの説明に出す");
});

test("描画: 取得中は再読み込みを無効にして連打を防ぐ", () => {
  const loading = render(notifications({ reloading: true }));
  assert.ok(actionTag(loading, "再読み込み").includes("disabled"), "取得中は押せない");
  assert.equal(loading.includes(UNSAVED_RELOAD_NOTE), false, "未編集なら理由は出さない");
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
  assert.equal((html.match(/>再読み込み<\/button>/g) ?? []).length, 1, "再読み込みは帯に 1 つだけ");
  assert.equal(actionTag(html, "再読み込み").includes("disabled"), false, "未編集では押せる");
});
