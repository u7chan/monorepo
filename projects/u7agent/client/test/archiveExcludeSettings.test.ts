// 「ダウンロードの除外」タブの中身（設定 → ファイル）。未設定・上書き・明示空・読み込み中・失敗（SSR）。
// ヘッダ / タブ / 保存の可否は filesSettingsPage.test.ts、HTTP は apiContracts で検査する。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ArchiveSettings } from "../src/hooks/useArchiveSettings";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import type { ArchiveSettingsResponse } from "../src/types";

const { ArchiveExcludeSettings } = await import("../src/components/ArchiveExcludeSettings");

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

function render(props: Partial<ArchiveSettings> = {}, input = ""): string {
  return renderToStaticMarkup(
    createElement(ArchiveExcludeSettings, {
      archiveSettings: fakeSettings(props),
      input,
      onInputChange: () => {},
      onSubmit: () => {},
    }),
  );
}

test("描画: 追加前の入力は親の値で描く (タブ往復で消えない)", () => {
  const html = render({}, "vendor");
  assert.match(html, /<input[^>]*value="vendor"/, "親が持つ入力値が出ていない");
});

test("描画: 未設定は既定の一覧を使用中として出し、行と件数を並べる", () => {
  const html = render();
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
});

test("描画: 上書き中はバッジが変わり、保存済みの一覧を出す", () => {
  const html = render({
    settings: settings({ excludeNames: ["dist", "vendor"], overridden: true }),
    draft: { excludeNames: ["dist", "vendor"] },
  });
  assert.ok(html.includes("上書き中"), "上書きのバッジが無い");
  assert.ok(html.includes("dist"), "保存済みの名前が出ていない");
  assert.ok(!html.includes("既定の一覧を使用中"), "未設定のバッジが残っている");
});

test("描画: 明示空は node_modules も入る警告を出す", () => {
  const html = render({
    settings: settings({ excludeNames: [], overridden: true }),
    draft: { excludeNames: [] },
  });
  assert.ok(html.includes("除外なし。"), "空の警告が無い");
  assert.match(
    html,
    /<summary[^>]*>[\s\S]*除外なし。node_modules なども ZIP に入るため、失敗しやすくなります。[\s\S]*<\/summary>/,
    "畳んだ 1 行の要点が無い",
  );
  assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:[\s=>])/, "警告は既定で畳む");
  assert.ok(html.includes("node_modules なども ZIP に入る"), "何が入るかの説明が無い");
  assert.ok(html.includes("100 MiB"), "上限の説明が無い");
  assert.ok(html.includes("0 / 100"), "件数が出ていない");
});

test("描画: 読み込み中は待ち表示、失敗は上の再読み込みを案内する", () => {
  const loading = render({ settings: null });
  assert.ok(loading.includes("読み込んでいます"), "読み込み中の表示が無い");
  const failed = render({ settings: null, note: { text: "読み込めませんでした", error: true } });
  assert.ok(failed.includes("読み込めませんでした") && failed.includes(RELOAD_ABOVE_NOTE), "再読み込みの導線が無い");
  assert.equal((failed.match(/>再読み込み<\/button>/g) ?? []).length, 0, "本文の枠に再読み込みを置かない");
  // note の本文 (失敗理由) はタブ側 (FileTreePage) の aria-live 行だけが出す
  const withNote = render({ note: { text: "除外名に使えない名前があります: a/b", error: true } });
  assert.ok(!withNote.includes("a/b"), "本文側に note の理由を二重に出している");
});
