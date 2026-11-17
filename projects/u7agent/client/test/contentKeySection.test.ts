// 帯の下に開くAPIキー欄。ページの静的描画では開閉を操作できないため、欄そのものを描いて
// 保存済み / 未設定 / runtime 不可の出し分けを固定する (開閉の既定は contentSettingsPage.test.ts)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ContentKeySection } from "../src/components/content-settings/ContentKeySection";

/** 「保存中」と「空入力」で同じ disabled になるため、保存の可否は入力ありの下書きで切り分ける */
const DRAFT = "sk-or-v1-0123456789";

function render(overrides: Partial<Parameters<typeof ContentKeySection>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ContentKeySection, {
      keyStored: true,
      apiKey: "",
      busy: false,
      runtimeAvailable: true,
      providerName: "OpenRouter",
      onChange: () => {},
      onSubmit: async () => {},
      onRemove: async () => {},
      ...overrides,
    }),
  );
}

const submitButton = (html: string): string =>
  /<button[^>]*type="submit"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)?.[0] ?? "";
const removeButton = (html: string): string =>
  /<button[^>]*class="btn-quiet"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/.exec(html)?.[0] ?? "";

test("保存済みでは上書き保存と削除を出し、入力欄は下書きだけを映す", () => {
  const html = render();
  assert.ok(html.includes(">上書き保存<"), "保存済みは上書きとして出す");
  assert.ok(html.includes(">削除<"), "削除の導線を出す");
  assert.ok(html.includes("新しいコンテンツ生成のAPIキー（上書き）"), "上書きであることを入力欄にも書く");
  assert.match(html, /<input[^>]*type="password"[^>]*value=""/, "空の下書きは空のまま（保存値は受け取らない）");
  assert.match(html, /<input[^>]*(?:autoComplete|autocomplete)="off"/, "再表示しない前提なので autocomplete を切る");
  assert.ok(
    html.includes("OpenRouter のコンテンツ生成（画像 / 音声 / BGM）で共有するキーです"),
    "どの provider のキーかと、別管理であることを出す",
  );
  assert.equal(html.includes("画像生成専用のキー"), false, "音声と共有するため画像専用とは書かない");

  // 保存済みでも欄は下書きをそのまま映す（保存値を差し込む経路が無いことを、値の反映で確かめる）
  assert.match(render({ apiKey: DRAFT }), /<input[^>]*type="password"[^>]*value="sk-or-v1-0123456789"/);
});

test("未設定では新規保存だけを出し、削除は出さない", () => {
  const html = render({ keyStored: false });
  assert.ok(html.includes(">保存<"));
  assert.equal(html.includes(">上書き保存<"), false);
  assert.equal(removeButton(html), "", "消す行が無いので削除を出さない");
  assert.ok(html.includes('コンテンツ生成のAPIキー"'), "未設定の placeholder");
});

test("runtime が無いときは、入力があってもキーの操作だけを無効にする", () => {
  const html = render({ runtimeAvailable: false, apiKey: DRAFT, keyStored: true });
  assert.match(html, /<input[^>]*type="password"[^>]*disabled=""/, "入力を disable する");
  // 空入力でも保存は押せないため、下書きを入れて「runtime のせいで押せない」ことを切り分ける
  assert.match(submitButton(html), /disabled=""/, "保存を disable する");
  assert.match(removeButton(html), /disabled=""/, "削除を disable する");
});

test("保存中は入力があっても二重送信させず、空入力では保存できない", () => {
  // busy のときと空入力のときで同じ disabled になるため、どちらも入力あり / なしで切り分ける
  assert.match(submitButton(render({ busy: true, apiKey: DRAFT })), /disabled=""/, "保存中は押せない");
  assert.doesNotMatch(submitButton(render({ busy: false, apiKey: DRAFT })), /disabled=""/, "入力があれば押せる");
  assert.match(submitButton(render({ apiKey: "" })), /disabled=""/, "空では押せない");
});
