import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ArchiveSettings } from "../src/hooks/useArchiveSettings";
import type { ArchiveSettingsResponse } from "../src/types";

const { ArchiveSettingsPage } = await import("../src/components/ArchiveSettingsPage");

const DEFAULTS = ["node_modules", ".venv", "dist"];

function settings(overrides: Partial<ArchiveSettingsResponse> = {}): ArchiveSettingsResponse {
  return {
    excludeNames: [...DEFAULTS],
    defaultExcludeNames: [...DEFAULTS],
    overridden: false,
    maxNames: 100,
    maxNameLength: 200,
    ...overrides,
  };
}

function fakeSettings(overrides: Partial<ArchiveSettings> = {}): ArchiveSettings {
  return {
    settings: settings(),
    draft: { excludeNames: [...DEFAULTS] },
    dirty: false,
    saving: false,
    note: { text: "変更はサーバーに保存され、再起動後も残ります。", error: false },
    add: () => true,
    remove: () => {},
    reload: async () => {},
    save: async () => true,
    reset: async () => true,
    discard: () => {},
    ...overrides,
  };
}

function render(props: Partial<ArchiveSettings> = {}): string {
  return renderToStaticMarkup(
    createElement(ArchiveSettingsPage, { archiveSettings: fakeSettings(props), onBack: () => {} }),
  );
}

/** 操作行の [保存] ボタンの開始タグ（disabled の有無を見るため） */
function saveButtonTag(html: string): string {
  const button = html
    .match(/<button[^>]*>[\s\S]*?<\/button>/g)
    ?.find((markup) => markup.replace(/<[^>]*>/g, "").trim() === "保存");
  assert.ok(button, "保存ボタンが無い");
  return button.slice(0, button.indexOf(">") + 1);
}

test("描画: 未設定は既定の一覧を使用中として出し、行と件数を並べる", () => {
  const html = render();
  assert.ok(html.includes("ARCHIVE"), "eyebrow が無い");
  assert.ok(html.includes("アーカイブの除外"), "タイトルが無い");
  assert.ok(html.includes("既定の一覧を使用中"), "未設定のバッジが無い");
  assert.ok(html.includes("3 / 100"), "件数が出ていない");
  for (const name of DEFAULTS) assert.ok(html.includes(name), `既定の名前が出ていない: ${name}`);
  // 規則の説明（パス指定不可 / symlink は常に対象外 / 上書きは既定の更新に追随しない）
  assert.ok(html.includes("ベース名の完全一致"), "名前の規則の説明が無い");
  assert.ok(html.includes("symlink は一覧に関係なく常に ZIP の対象外"), "symlink の説明が無い");
  assert.ok(html.includes("以後のアプリ更新で既定が増えても"), "上書きの説明が無い");
  assert.ok(html.includes("200 文字まで、100 件まで"), "上限の説明が無い");
  // 説明は JSX のテキストなので、Markdown の記法（バッククォート）を書くと文字として出る。`/` は code で描く
  assert.ok(html.includes("（<code>/</code>を含まない）"), "スラッシュが code で描かれていない");
  assert.ok(!html.includes("`"), "バッククォートが文字として描画されている");
  assert.ok(!html.includes("除外なし。"), "空でないのに空の警告が出ている");
  // 差分が無いので保存できない。既定に戻す対象も無い
  assert.ok(saveButtonTag(html).includes("disabled"), "未編集でも保存できる");
});

test("描画: 上書き中はバッジが変わり、差分があると保存できる", () => {
  const html = render({
    settings: settings({ excludeNames: ["dist", "vendor"], overridden: true }),
    draft: { excludeNames: ["dist", "vendor"] },
  });
  assert.ok(html.includes("上書き中"), "上書きのバッジが無い");
  assert.ok(html.includes("dist"), "保存済みの名前が出ていない");
  assert.ok(!html.includes("既定の一覧を使用中"), "未設定のバッジが残っている");

  const dirty = render({ draft: { excludeNames: [...DEFAULTS, "vendor"] }, dirty: true });
  assert.ok(!saveButtonTag(dirty).includes("disabled"), "差分があるのに保存できない");
});

test("描画: 明示空は node_modules も入る警告を出す", () => {
  const html = render({
    settings: settings({ excludeNames: [], overridden: true }),
    draft: { excludeNames: [] },
  });
  assert.ok(html.includes("除外なし。"), "空の警告が無い");
  assert.ok(html.includes("node_modules なども ZIP に入る"), "何が入るかの説明が無い");
  assert.ok(html.includes("100 MiB"), "上限の説明が無い");
  assert.ok(html.includes("0 / 100"), "件数が出ていない");
});

test("描画: note のエラーは aria-live の行にそのまま出る", () => {
  const html = render({ note: { text: "除外名に使えない名前があります: a/b", error: true } });
  assert.ok(html.includes('aria-live="polite"'), "note の行が無い");
  assert.ok(html.includes("除外名に使えない名前があります: a/b"), "理由が出ていない");

  // 読み込み中 / 読み込み失敗は一覧を出さず、再読み込みの導線を出す
  const loading = render({ settings: null });
  assert.ok(loading.includes("読み込んでいます"), "読み込み中の表示が無い");
  const failed = render({ settings: null, note: { text: "読み込めませんでした", error: true } });
  assert.ok(failed.includes("読み込めませんでした") && failed.includes("再読み込み"), "再読み込みの導線が無い");
});
