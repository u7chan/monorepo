// 設定 → ファイル のタブと面のツールバー。既定はファイルツリー、`/settings/files/archive` はダウンロードの除外。
// ツリーの行は SSR では出ないため、見るのは見出し / タブ / 操作 / note の出し分け (行は fileRowMenu / fileTree)。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ArchiveSettings } from "../src/hooks/useArchiveSettings";
import { UNSAVED_RELOAD_NOTE } from "../src/lib/settingsNotes";
import type { FilesSubsection } from "../src/lib/settingsNav";
import type { ArchiveSettingsResponse } from "../src/types";

// api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { FileTreePage } = await import("../src/components/FileTreePage");
const { ConfirmProvider } = await import("../src/components/ConfirmProvider");

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
    reloading: false,
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

function render(
  filesSubsection?: FilesSubsection,
  archive: Partial<ArchiveSettings> = {},
  cwd = "",
  singleColumn = false,
): string {
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(FileTreePage, {
        cwd,
        excludeNames: [],
        archiveSettings: fakeSettings(archive),
        filesSubsection,
        singleColumn,
        onSelectFilesSubsection: () => {},
        onOpenSharingExclusions: () => {},
        onBack: () => {},
      }),
    ),
  );
}

/** role=tab の button を [ラベル, 選択中] の順で返す */
function tabs(html: string): [string, boolean][] {
  return [...html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => [
    match[1].replace(/<[^>]*>/g, "").trim(),
    match[0].includes('aria-selected="true"'),
  ]);
}

/** 操作行のボタンの開始タグ（disabled の有無を見るため） */
function actionTag(html: string, label: string): string {
  const button = html
    .match(/<button[^>]*>[\s\S]*?<\/button>/g)
    ?.find((markup) => markup.replace(/<[^>]*>/g, "").trim() === label);
  assert.ok(button, `${label} ボタンが無い`);
  return button.slice(0, button.indexOf(">") + 1);
}

test("描画: 既定はファイルツリーのタブで、ヘッダは ファイル / FILES を出す", () => {
  const html = render();
  assert.ok(html.includes("FILES"), "eyebrow が無い");
  assert.ok(html.includes(">ファイル<"), "タイトルが無い");
  assert.deepEqual(tabs(html), [
    ["ファイルツリー", true],
    ["ダウンロードの除外", false],
  ]);
  assert.ok(html.includes("再読み込み"), "ツリーの操作が無い");
  assert.ok(!html.includes("既定に戻す"), "ツリー側に除外の操作が出ている");
  // note の行は除外タブだけが持つ (ツリーは行にエラーを出す)
  assert.ok(!html.includes('aria-live="polite"'), "ツリー側に note の行がある");
});

test("描画: ツリー面は root のパスを caption にも帯にも出さない", () => {
  // root は常にワークスペース root ("/") で、面を選ぶ情報にならないため、左スロットは空のまま置く
  const html = render("files", {}, ".u7agent/sessions/s1");
  assert.ok(!html.includes(".u7agent/sessions/s1"), "ツリー面に root のパスが出ている");
});

test("描画: 除外タブは説明と操作を出し、note を aria-live で読ませる", () => {
  const html = render("archive", { note: { text: "除外名に使えない名前があります: a/b", error: true } });
  assert.deepEqual(tabs(html), [
    ["ファイルツリー", false],
    ["ダウンロードの除外", true],
  ]);
  assert.ok(html.includes("ダウンロードから除外する名前を決めます。"), "説明が無い");
  assert.ok(html.includes("除外の規則"), "除外の本文が出ていない");
  assert.ok(html.includes("破棄") && html.includes("既定に戻す"), "除外の操作が無い");
  assert.ok(html.includes('aria-live="polite"') && html.includes("a/b"), "note が読まれない");
  assert.ok(html.includes("再読み込み"), "除外タブにも取り直しを常設する");
  assert.ok(html.indexOf("再読み込み") < html.indexOf("破棄"), "再読み込みは保存群の左に置く");
  assert.equal(html.includes(UNSAVED_RELOAD_NOTE), false, "変更が無い間は理由を出さない");
});

test("描画: 除外タブの再読み込みは、取得中と未保存の変更がある間だけ無効にする", () => {
  const initial = render("archive");
  assert.equal(actionTag(initial, "再読み込み").includes("disabled"), false, "未編集では押せる");

  const loading = render("archive", { reloading: true });
  assert.ok(actionTag(loading, "再読み込み").includes("disabled"), "取得中は連打できない");

  const changed = render("archive", {
    settings: settings({ excludeNames: ["dist", "vendor"], overridden: true }),
    draft: { excludeNames: [...DEFAULTS, "vendor"] },
    dirty: true,
  });
  assert.ok(actionTag(changed, "再読み込み").includes("disabled"), "下書きを捨てる再読み込みを押せなくする");
  assert.ok(changed.includes(UNSAVED_RELOAD_NOTE), "押せない理由を出す");
});

test("描画: singleColumn では押せない理由をヘッダに出し、帯には出さない", () => {
  const changed = {
    settings: settings({ excludeNames: ["dist", "vendor"], overridden: true }),
    draft: { excludeNames: [...DEFAULTS, "vendor"] },
    dirty: true,
  };
  // 帯は操作で埋まり、理由が 1 文字幅まで潰れるため、狭い幅ではヘッダ側で折り返して読ませる
  const html = render("archive", changed, "", true);
  const noteAt = html.indexOf(UNSAVED_RELOAD_NOTE);
  assert.ok(noteAt >= 0, "狭い幅でも押せない理由を出す");
  assert.ok(noteAt < html.indexOf('role="tablist"'), "理由はタブ行より上 (ヘッダ) に出す");

  // desktop は帯の左で理由が読めるので、操作と同じ行のままにする
  const desktop = render("archive", changed);
  assert.ok(desktop.indexOf(UNSAVED_RELOAD_NOTE) > desktop.indexOf('role="tablist"'), "desktop は帯に出す");
});

test("描画: 除外の [保存] は差分があるときだけ、[既定に戻す] は上書き中だけ押せる", () => {
  const initial = render("archive");
  assert.ok(actionTag(initial, "保存").includes("disabled"), "未編集でも保存できる");
  assert.ok(actionTag(initial, "既定に戻す").includes("disabled"), "未設定でも既定に戻せる");

  const changed = render("archive", {
    settings: settings({ excludeNames: ["dist", "vendor"], overridden: true }),
    draft: { excludeNames: [...DEFAULTS, "vendor"] },
    dirty: true,
  });
  assert.ok(!actionTag(changed, "保存").includes("disabled"), "差分があるのに保存できない");
  assert.ok(!actionTag(changed, "既定に戻す").includes("disabled"), "上書き中なのに既定に戻せない");
});
