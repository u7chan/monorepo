// 帯の下に開くAPIキー欄。ページの静的描画では開閉を操作できないため、欄そのものを描いて
// 保存済み / 未設定 / runtime 不可の出し分けを固定する (開閉の既定は contentSettingsPage.test.ts)。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ContentKeySection } from "../src/components/content-settings/ContentKeySection";

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

test("保存済みでは上書き保存と削除を出し、保存したキーは欄へ戻さない", () => {
  const html = render();
  assert.ok(html.includes(">上書き保存<"), "保存済みは上書きとして出す");
  assert.ok(html.includes(">削除<"), "削除の導線を出す");
  assert.ok(html.includes("新しいコンテンツ生成のAPIキー（上書き）"), "上書きであることを入力欄にも書く");
  assert.match(html, /<input[^>]*type="password"[^>]*value=""/, "保存済みの値は戻さない");
  assert.match(html, /<input[^>]*(?:autoComplete|autocomplete)="off"/, "再表示しない前提なので autocomplete を切る");
  assert.ok(
    html.includes("OpenRouter のコンテンツ生成（画像 / 音声 / BGM）で共有するキーです"),
    "どの provider のキーかと、別管理であることを出す",
  );
  assert.equal(html.includes("画像生成専用のキー"), false, "音声と共有するため画像専用とは書かない");
});

test("未設定では新規保存だけを出し、削除は出さない", () => {
  const html = render({ keyStored: false });
  assert.ok(html.includes(">保存<"));
  assert.equal(html.includes(">上書き保存<"), false);
  assert.equal(html.includes(">削除<"), false, "消す行が無いので削除を出さない");
  assert.ok(html.includes('コンテンツ生成のAPIキー"'), "未設定の placeholder");
});

test("runtime が無いときはキーの操作だけを無効にする", () => {
  const html = render({ runtimeAvailable: false });
  assert.match(html, /<input[^>]*type="password"[^>]*disabled=""/, "入力を disable する");
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/, "保存を disable する");
  assert.match(html, /<button[^>]*class="btn-quiet"[^>]*disabled=""/, "削除を disable する");
});

test("保存中は二重送信させず、入力が空なら保存できない", () => {
  assert.match(render({ busy: true }), /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(render({ apiKey: "" }), /<button[^>]*type="submit"[^>]*disabled=""/, "空では押せない");
  assert.doesNotMatch(render({ apiKey: "sk-or-v1-0123456789" }), /<button[^>]*type="submit"[^>]*disabled=""/);
});
