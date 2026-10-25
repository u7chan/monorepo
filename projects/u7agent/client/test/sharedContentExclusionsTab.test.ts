// 「公開の除外」タブの中身（設定 → 共有）。未設定・上書き・明示空・読み込み中・失敗（SSR）。
// タブの並びと操作行は settingsNav / cloudflareSettingsPage で、HTTP は apiContracts で検査する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { SharedContentExclusionsSettings } from "../src/hooks/useSharedContentExclusions";
import { RELOAD_ABOVE_NOTE } from "../src/lib/settingsNotes";
import type { SharedContentExclusionsResponse } from "../src/types";

const { SharedContentExclusionsTab } = await import("../src/components/sharing-settings/SharedContentExclusionsTab");

const DEFAULTS = ["AGENTS.md", "README.md", ".env"];

function settings(overrides: Partial<SharedContentExclusionsResponse> = {}): SharedContentExclusionsResponse {
  return {
    excludeNames: [...DEFAULTS],
    defaultExcludeNames: [...DEFAULTS],
    overridden: false,
    maxNames: 100,
    maxNameLength: 200,
    ...overrides,
  };
}

function fakeSettings(overrides: Partial<SharedContentExclusionsSettings> = {}): SharedContentExclusionsSettings {
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

function render(props: Partial<SharedContentExclusionsSettings> = {}, input = ""): string {
  return renderToStaticMarkup(
    createElement(SharedContentExclusionsTab, {
      exclusions: fakeSettings(props),
      input,
      onInputChange: () => {},
      onSubmit: () => {},
      onOpenArchiveExclusions: () => {},
    }),
  );
}

test("描画: 公開の既定を出し、公開だけの規則とダウンロードの除外への導線を示す", () => {
  const html = render();
  assert.ok(html.includes("既定の一覧を使用中"), "未設定のバッジが無い");
  assert.ok(html.includes("3 / 100"), "件数が出ていない");
  for (const name of DEFAULTS) assert.ok(html.includes(name), `既定の名前が出ていない: ${name}`);
  assert.ok(html.includes("ベース名の完全一致"), "名前の規則の説明が無い");
  assert.ok(html.includes("対象ディレクトリ自身の名前と同じ除外名は、その共有では使いません"), "自己除外の説明が無い");
  assert.ok(html.includes("公開に必要なため除外できません"), "index.html の説明が無い");
  assert.ok(html.includes("除外は事故防止で、秘匿の保証ではありません"), "秘匿の保証ではない説明が無い");
  assert.ok(html.includes("ダウンロードの除外を開く"), "ダウンロードの除外への導線が無い");
  // 説明は JSX のテキストなので、Markdown の記法（バッククォート）を書くと文字として出る
  assert.ok(!html.includes("`"), "バッククォートが文字として描画されている");
  assert.ok(!html.includes("除外なし。"), "空でないのに空の警告が出ている");
});

test("描画: 追加前の入力は親の値で描く (タブ往復で消えない)", () => {
  const html = render({}, "AGENTS.md");
  assert.match(html, /<input[^>]*value="AGENTS\.md"/, "親が持つ入力値が出ていない");
});

test("描画: 上書き中はバッジが変わり、保存済みの一覧を出す", () => {
  const html = render({
    settings: settings({ excludeNames: ["AGENTS.md"], overridden: true }),
    draft: { excludeNames: ["AGENTS.md"] },
  });
  assert.ok(html.includes("上書き中"), "上書きのバッジが無い");
  assert.ok(!html.includes("既定の一覧を使用中"), "未設定のバッジが残っている");
});

test("描画: 明示空は何も落とさない警告を出す", () => {
  const html = render({
    settings: settings({ excludeNames: [], overridden: true }),
    draft: { excludeNames: [] },
  });
  assert.ok(html.includes("除外なし。AGENTS.md や .env も公開されます。"), "空の警告が無い");
  assert.ok(html.includes("0 / 100"), "件数が出ていない");
});

test("描画: 読み込み中は待ち表示、失敗は上の再読み込みを案内する", () => {
  const loading = render({ settings: null });
  assert.ok(loading.includes("公開の除外名を読み込んでいます"), "読み込み中の表示が無い");
  const failed = render({ settings: null, note: { text: "読み込めませんでした", error: true } });
  assert.ok(failed.includes("公開の除外名を読み込めませんでした") && failed.includes(RELOAD_ABOVE_NOTE));
  assert.equal((failed.match(/>再読み込み<\/button>/g) ?? []).length, 0, "本文の枠に再読み込みを置かない");
});

test("描画: 保存値と違う下書きには未保存のバッジを出し、保存値に戻れば消す", () => {
  // 追加しただけでは公開に反映されないことを、一覧の見出しで気づけるようにする
  assert.equal(render().includes(">未保存<"), false, "保存値と同じなのに未保存を出す");
  const added = render({ draft: { excludeNames: [...DEFAULTS, ".venv"] } });
  assert.ok(added.includes(">未保存<"), "保存していない一覧に未保存のバッジが無い");
  assert.ok(added.includes(".venv"), "下書きの名前が出ていない");
});
