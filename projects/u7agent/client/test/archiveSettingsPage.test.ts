// 設定 → アーカイブ（client/src/components/ArchiveSettingsPage.tsx）の描画と配線。client に DOM テスト基盤が
// 無いため、react-dom/server で描画して「未設定 / 上書き / 明示空 / エラー」の出し分けを固定し、保存と
// 既定に戻すの配線（PUT / DELETE と app 状態の更新）はソース走査で固定する。
//   1. 未設定のときは「既定の一覧を使用中」を出し、既定の一覧と件数をそのまま見せる
//   2. 明示空（全部消した）ときは node_modules も入る警告を出す
//   3. 保存 / 読み込みの結果は note 行に出る（aria-live は SettingsPageLayout が持つ）
//   4. [保存] は PUT、[既定に戻す] は DELETE。どちらも応答で app 状態（ツリーの出し分け）が更新される
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { ArchiveSettings } from "../src/hooks/useArchiveSettings";
import type { ArchiveSettingsResponse } from "../src/types";

const { ArchiveSettingsPage } = await import("../src/components/ArchiveSettingsPage");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

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
  return html.match(/<button[^>]*class="btn-primary"[^>]*>/)?.[0] ?? "";
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

test("配線: 保存は PUT、既定に戻すは DELETE で、応答を app 状態へ反映する", () => {
  const hook = read("src/hooks/useArchiveSettings.ts");
  assert.ok(hook.includes("await updateArchiveSettings(draft.excludeNames)"), "保存が PUT になっていない");
  assert.ok(hook.includes("await resetArchiveSettings()"), "既定に戻すが DELETE になっていない");
  // 応答の適用は settings と draft の両方（画面が新しい一覧をそのまま映す）
  assert.ok(hook.includes("applySettings(next)"), "応答を適用していない");
  assert.match(
    hook,
    /const applySettings = useCallback\(\(next: ArchiveSettingsResponse\) => \{[\s\S]*?setSettings\(next\)[\s\S]*?setDraftState\(draftFromSettings\(next\)\)/,
  );
  // 不正名は PUT の前に止め、理由を note へ出す（サーバーの 400 は同じ文言）
  assert.ok(
    hook.includes("validateExcludeNames(draft, settings.maxNames, settings.maxNameLength)"),
    "保存前の検証が無い",
  );
  // 起動時に読み込む（ツリーの行の出し分けが設定ページを開かなくても追随する）
  assert.match(hook, /useEffect\(\(\) => \{\n    void reload\(\);\n  \}, \[reload\]\)/);

  const api = read("src/api.ts");
  assert.ok(api.includes("client.api.settings.archive.$get()"), "GET が無い");
  assert.ok(api.includes("client.api.settings.archive.$put"), "PUT が無い");
  assert.ok(api.includes("client.api.settings.archive.$delete()"), "DELETE が無い");

  const page = read("src/components/ArchiveSettingsPage.tsx");
  assert.ok(page.includes("onClick={() => void save()}"), "保存の配線が無い");
  assert.ok(page.includes("onClick={() => void reset()}"), "既定に戻すの配線が無い");
  assert.ok(page.includes("disabled={!dirty || saving}"), "未編集でも保存できる");
  assert.ok(page.includes("disabled={!settings?.overridden || saving}"), "未設定でも既定に戻せる");
});

test("配線: 行の出し分けは app 状態の実効値を使い、保存の直後に追随する", () => {
  const app = read("src/App.tsx");
  assert.ok(app.includes("app.archiveSettings.settings?.excludeNames ?? []"), "実効値の出所が app 状態でない");
  assert.ok(app.includes("excludeNames={excludeNames}"), "ツリーへ渡していない");
  assert.ok(
    app.includes("<ArchiveSettingsPage {...pageProps} archiveSettings={app.archiveSettings} />"),
    "ページの配線が無い",
  );
  // 設定 → ファイルとチャット右パネルの両方が同じ値を使う
  assert.match(app, /<FileTreePage \{[^}]*\} cwd="" excludeNames=\{excludeNames\} \/>/);
  assert.match(app, /<SessionFilesPanel[\s\S]*?excludeNames=\{excludeNames\}/);

  // FileBrowser は health を取りに行かず、prop だけを使う（保存直後の追随と取得元の一本化）
  const browser = read("src/components/FileBrowser.tsx");
  assert.ok(!browser.includes("getHealth"), "FileBrowser が health を取りに行っている");
  assert.ok(!browser.includes("health.archive?.excludeNames"), "FileBrowser が health から除外名を読んでいる");
  assert.ok(browser.includes("isArchiveExcludedName(name, excludeNames)"), "除外の判定が純関数でない");
  // 設定ページ以外の面（スキルのファイルタブ）も prop を要求する
  for (const file of ["src/components/FileTreePage.tsx", "src/components/SessionFilesPanel.tsx"]) {
    assert.ok(read(file).includes("excludeNames"), `${file} が excludeNames を受けていない`);
  }
});
