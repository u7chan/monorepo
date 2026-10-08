// 画像生成タブの初期描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 未設定 / 設定済み / runtime 不可の出し分けと、保存済みキーを表示しないことを固定する
// (入力の後始末・選択肢・PUT の本文・確認文は lib/imageSettings の純関数テストが担う)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ImageSettingsTab } from "../src/components/model-settings/ImageSettingsTab";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import type { ImageSettingsResponse } from "../src/types";

const MODELS = [
  { provider: "openrouter", id: "openai/gpt-image-2", name: "GPT Image 2" },
  { provider: "openrouter", id: "google/gemini-image", name: "Gemini Image" },
];

function settings(overrides: Partial<ImageSettingsResponse> = {}): ImageSettingsResponse {
  return {
    configured: true,
    provider: "openrouter",
    model: "openai/gpt-image-2",
    models: MODELS,
    catalogSource: "live",
    fetchedAt: null,
    runtimeAvailable: true,
    ...overrides,
  };
}

function render(
  overrides: Partial<ImageSettingsResponse> = {},
  saving: "key" | "delete" | "selection" | "catalog" | null = null,
): string {
  // 確認ダイアログの provider は app の root が持つ (main.tsx)。ここでは描画だけを検査する
  return renderToStaticMarkup(
    createElement(
      ConfirmProvider,
      null,
      createElement(ImageSettingsTab, {
        settings: settings(overrides),
        saving,
        onSaveKey: async () => true,
        onDeleteKey: async () => true,
        onSaveSelection: async () => true,
        onRefreshCatalog: async () => true,
      }),
    ),
  );
}

test("未設定ではキー入力だけを出し、モデル選択と削除は出さない", () => {
  const html = render({ configured: false, provider: null, model: null, catalogSource: "sdk", fetchedAt: null });
  assert.ok(html.includes('type="password"'), "キー入力を出す");
  assert.match(html, /<input[^>]*(?:autoComplete|autocomplete)="off"/, "再表示しない前提なので autocomplete を切る");
  assert.ok(html.includes("OpenRouter の画像生成専用のキーです"), "どの provider のキーかと、別管理であることを出す");
  assert.ok(html.includes(">未設定<"), "未設定バッジを出す");
  assert.equal(html.includes("設定済み"), false, "未設定では設定済みと言わない");
  assert.equal(html.includes("<select"), false, "モデル選択はキー保存後にだけ出す");
  assert.equal(html.includes(">削除</button>"), false, "削除もキー保存後にだけ出す");
  assert.equal(html.includes(">再取得</button>"), false, "再取得もモデル欄と同じくキー保存後にだけ出す");
});

test("見出しに provider のロゴ・名前・id とキーの登録状態を出す", () => {
  const html = render();
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/, "ロゴを出す (プロバイダータブと同じ対応表を引く)");
  assert.ok(html.includes(">OpenRouter</h2>"), "provider の表示名を出す");
  assert.ok(html.includes(">openrouter</code>"), "モデル欄の id 表記と結び付くように provider id も出す");
  assert.ok(html.includes(">設定済み<"), "登録状態を provider の見出しへ出す");
  assert.ok(
    html.includes('rounded border px-1.5 py-0.5 text-2xs whitespace-nowrap border-line text-ink-muted">カタログ 2<'),
    "カタログの件数もプロバイダータブと同じチップで出す",
  );
});

test("未設定でも、これから登録するキーの provider の見出しは出す", () => {
  const html = render({ configured: false, provider: null, model: null, catalogSource: "sdk", fetchedAt: null });
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/, "この画面で登録するキーの provider のロゴを出す");
  assert.ok(html.includes(">OpenRouter</h2>"), "未設定でも同じ provider の名前を出す");
  assert.ok(html.includes(">未設定<"), "登録状態は未設定のまま出す");
});

test("対応表に無い provider の見出しは頭文字のタイルへ落とす", () => {
  const html = render({ provider: "faux-image" });
  assert.ok(html.includes(">FI<"), "ロゴが無い provider も名前の頭文字で見分けられる");
  assert.ok(html.includes(">faux-image</h2>"), "知らない provider は id のまま出す");
});

test("設定済みでは上書き保存・削除・モデル選択を出し、保存済みキーを入力欄へ戻さない", () => {
  const html = render();
  assert.ok(html.includes("上書き保存"));
  assert.ok(html.includes(">設定済み<"), "設定済みバッジを出す");
  assert.ok(html.includes(">削除</button>"));
  assert.ok(html.includes("<select"), "モデル選択を出す");
  assert.ok(html.includes('value="openrouter/openai/gpt-image-2"'), "保存済みモデルを選択した状態で出す");
  assert.ok(html.includes("GPT Image 2"));
  assert.ok(html.includes("モデル一覧は OpenRouter から取得しました"), "一覧の出どころを出す");
  assert.ok(
    html.includes(
      'rounded border px-1.5 py-0.5 text-2xs inline-block max-w-full leading-relaxed whitespace-normal border-line text-ink-muted">モデル一覧は OpenRouter から取得しました',
    ),
    "出どころもプロバイダータブと同じチップで出し、狭い幅でも 1 つの枠のまま折り返す",
  );
  assert.match(
    html,
    /<p[^>]*><span class="rounded border[^"]*">モデル一覧は OpenRouter から取得しました/,
    "文をチップにしても段落のセマンティクスを残す",
  );
  assert.ok(html.includes("サイズ・品質・出力形式は provider の既定を使います"), "設定できる範囲の説明を残す");
  assert.equal(html.includes("プロバイダー: OpenRouter"), false, "見出しと重複する provider 名を本文で繰り返さない");
  assert.ok(html.includes(">再取得</button>"));
  const input = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(input.includes('value=""'), "保存済みのキーは入力欄へ戻さない");
});

test("取得できていないときは一覧の出どころを警告色のチップで出す", () => {
  const stored = render({ catalogSource: "stored", fetchedAt: 0 });
  assert.ok(stored.includes("OpenRouter から取得できなかったため、前回の一覧を表示しています"));
  assert.match(stored, /border-warn\/40 text-warn"[^>]*>OpenRouter から取得できなかった/);
  const sdk = render({ catalogSource: "sdk", fetchedAt: null });
  assert.ok(sdk.includes("SDK の組み込み一覧を表示しています"));
});

test("再取得中はボタンを取得中にする", () => {
  const html = render({}, "catalog");
  assert.ok(html.includes("取得中"), "進行中を出す");
  assert.match(html, /<button[^>]*class="btn-quiet"[^>]*disabled=""[^>]*><[^>]*>.*取得中/s, "連打できないようにする");
});

test("カタログ外の保存済みモデルも選択肢に残す", () => {
  const html = render({ model: "stale/model" });
  assert.ok(html.includes("stale/model（カタログ外）"), "現在の保存値を選択肢に出す");
  assert.ok(html.includes('value="openrouter/stale/model"'));
  assert.ok(html.includes("Gemini Image"), "カタログの他の候補も失わない");
});

test("平文の注意は既定で畳み、1 行の要点を出す", () => {
  const html = render();
  assert.match(
    html,
    /<summary[^>]*>[\s\S]*キーは平文で保存されます。ログインがないため公開しないでください。[\s\S]*<\/summary>/,
    "畳んだ 1 行にキーの保存と公開の注意を出す",
  );
  assert.equal(html.includes("<details open"), false, "既定は畳む");
  assert.ok(html.includes("登録したキーはアプリのデータベース（SQLite）へ平文で保存され"), "展開で元の本文を読める");
});

test("runtimeAvailable: false ではキー操作だけを無効化し、モデル変更は残す", () => {
  const html = render({ runtimeAvailable: false });
  assert.ok(html.includes("ランタイムが利用できないため"), "変更できないことを先に伝える");
  assert.match(html, /<input[^>]*type="password"[^>]*disabled=""/, "キー入力を disable する");
  assert.match(html, /<button[^>]*class="btn-quiet"[^>]*disabled=""/, "削除を disable する");
  // モデルの変更は SDK に触れないため、runtime が無くてもサーバーは受け付ける
  assert.doesNotMatch(html, /<select[^>]*disabled=""/, "モデル選択は disable しない");
});
