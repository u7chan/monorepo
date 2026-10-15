// ツール欄 (ToolSelector) の描画。client に DOM テスト基盤が無いため、react-dom/server の静的描画で
// 行の状態 (チェック / 理由 / 依存の注記) と一括操作の出し分けを固定する。

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  TOOL_CARD_NOTE,
  TOOL_CATALOG_UNAVAILABLE_NOTE,
  TOOL_DISABLE_ALL_LABEL,
  TOOL_EXPLICIT_NOTE,
  TOOL_SHOW_ALL_LABEL,
} from "../src/lib/tools";
import type { ToolCatalogEntry, ToolUnavailableReason } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { ToolSelector } = await import("../src/components/agent-settings/ToolSelector");

const TOOLS: ToolCatalogEntry[] = [
  { name: "read", description: "ファイルの内容を読む", group: "sandbox", available: true },
  { name: "bash", description: "シェルコマンドを実行する", group: "sandbox", available: true },
  {
    name: "serve",
    description: "アプリを起動・確認・停止する",
    group: "app",
    available: false,
    reason: "app_disabled",
  },
];

function render({
  tools = TOOLS,
  toolNames,
}: {
  tools?: ToolCatalogEntry[];
  toolNames?: string[] | null;
} = {}): string {
  return renderToStaticMarkup(
    createElement(ToolSelector, {
      tools,
      toolNames,
      onToggleTool: () => {},
      onShowAllTools: () => {},
      onDisableAllTools: () => {},
    }),
  );
}

/** 描画順のチェックボックスの checked */
function checkboxes(html: string): boolean[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0].includes('checked=""'));
}

test("未指定は全部 ON、空の明示リストはすべて OFF (グループごとの件数も出す)", () => {
  const unspecified = render();
  assert.deepEqual(checkboxes(unspecified), [true, true, true]);
  assert.ok(unspecified.includes("作業ツール"));
  assert.ok(unspecified.includes("アプリのツール"));
  assert.ok(unspecified.includes("使用 3 / 全 3"));
  // 解除 (null) も未指定と同じ全部 ON
  assert.deepEqual(checkboxes(render({ toolNames: null })), [true, true, true]);

  const explicit = render({ toolNames: ["read"] });
  assert.deepEqual(checkboxes(explicit), [true, false, false]);
  assert.ok(explicit.includes("使用 1 / 全 3"));
});

test("アプリ側で使えない行は理由を出し、チェックは入っていても使えないと伝える", () => {
  const html = render();
  assert.ok(html.includes("アプリ側で無効です。チェックしても使えません"));
  // 使える行には理由を出さない
  assert.ok(!html.includes("この構成では無効です"));
});

test("アプリ側の理由コードごとに文言を変え、未知のコードでも行を壊さない", () => {
  const reasons: ToolUnavailableReason[] = ["deploy_allowlist", "app_disabled", "no_key"];
  const notes = reasons.map((reason) =>
    render({ tools: [{ name: "serve", description: "", group: "app", available: false, reason }] }),
  );
  assert.match(notes[0], /PI_AGENT_TOOLS/);
  assert.match(notes[1], /アプリ側で無効/);
  assert.match(notes[2], /キーが未設定/);
  // サーバーが理由を増やしても画面は落とさず、汎用の文言へ落とす (応答のキャストで未知の値を作る)
  const unknown = render({
    tools: [
      { name: "serve", description: "", group: "app", available: false, reason: "brand_new" as ToolUnavailableReason },
    ],
  });
  assert.ok(unknown.includes("いまは使えません。チェックしても使えません"));
});

test("外した行だけに依存の注記を出し、チェックを戻す文言と注記は同時に出さない", () => {
  const off = render({ toolNames: ["read", "serve"] });
  // 外した行 (bash) には依存の注記、外していない行には出さない
  assert.ok(off.includes("bash からはファイルへ書き込めます"));
  const onRead = render({ toolNames: ["bash", "serve"] });
  assert.ok(onRead.includes("スキル本文を読めなくなり"));

  // 使えない理由と外したときの依存は別の情報なので、両方出す
  const serve = render({ toolNames: ["read", "bash"] });
  assert.ok(serve.includes("組み込みスキル serve の手順はこのツールを使うため"));
  assert.ok(serve.includes("アプリ側で無効です。チェックしても使えません"));
});

test("一括操作は明示リストと OFF の有無で出し分ける", () => {
  const unspecified = render();
  assert.ok(!unspecified.includes(TOOL_SHOW_ALL_LABEL));
  assert.ok(unspecified.includes(TOOL_DISABLE_ALL_LABEL));

  const explicit = render({ toolNames: ["read"] });
  assert.ok(explicit.includes(TOOL_SHOW_ALL_LABEL));
  assert.ok(explicit.includes(TOOL_DISABLE_ALL_LABEL));
  assert.ok(explicit.includes(TOOL_EXPLICIT_NOTE));

  // すべて OFF のときは外す対象が無い
  const off = render({ toolNames: [] });
  assert.ok(off.includes(TOOL_SHOW_ALL_LABEL));
  assert.ok(!off.includes(TOOL_DISABLE_ALL_LABEL));
});

test("カードの注記は新しい会話にだけ効くことと、アプリ側の可否を伝える", () => {
  const html = render();
  assert.ok(html.includes(TOOL_CARD_NOTE));
  assert.match(html, /新しい会話/);
  assert.match(html, /開いている会話の振る舞いは変わりません/);
  assert.match(html, /キー未設定の画像 \/ 音声/);
});

test("一覧に無い保存名は落とさず見つからない旨を出し、保存名は増減しない", () => {
  const html = render({ toolNames: ["read", "gone"] });
  assert.ok(html.includes("見つかりません"));
  assert.ok(html.includes("gone"));
  assert.deepEqual(checkboxes(html), [true, false, false]);
});

test("一覧を取得できないときは、行ではなく理由を出す", () => {
  const html = render({ tools: [] });
  assert.ok(html.includes(TOOL_CATALOG_UNAVAILABLE_NOTE));
  assert.equal(html.includes("作業ツール"), false);
  assert.equal(html.includes("<input"), false);
});
