// エージェント編集のツールタブ。行は行全体が 1 つの role="switch" で、作業ツール → アプリのツールの順。
// 一括操作はグループ単位 (「すべて外す」) で、ツールは 1 本の toolNames を共有する。
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { TOOL_CARD_NOTE, TOOL_CATALOG_UNAVAILABLE_NOTE, TOOL_EXPLICIT_NOTE, TOOL_GROUP_LABELS } from "../src/lib/tools";
import { ALLOWLIST_DISABLE_GROUP_LABEL, ALLOWLIST_RESET_LABEL } from "../src/lib/allowlistText";
import type { ToolCatalogEntry, ToolGroup, ToolUnavailableReason } from "../src/types";

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
      onDisableToolGroup: (_group: ToolGroup) => {},
      onResetTools: () => {},
    }),
  );
}

/** 行のスイッチを描画順に取る */
function switches(html: string): { label: string; checked: boolean }[] {
  return [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes("を使う"))
    .map((tag) => ({
      label: tag.match(/aria-label="([^"]*)"/)?.[1] ?? "",
      checked: tag.includes('aria-checked="true"'),
    }));
}

test("未指定は全部 ON、空の明示リストはすべて OFF、グループは作業ツールが先頭", () => {
  const unspecified = render();
  assert.deepEqual(
    switches(unspecified).map((row) => [row.label, row.checked]),
    [
      ["read を使う", true],
      ["bash を使う", true],
      ["serve を使う", true],
    ],
  );
  assert.ok(unspecified.indexOf(TOOL_GROUP_LABELS.sandbox) < unspecified.indexOf(TOOL_GROUP_LABELS.app));
  assert.ok(unspecified.includes("使用 3 / 全 3"));
  assert.deepEqual(
    switches(render({ toolNames: null })).map((row) => row.checked),
    [true, true, true],
  );

  const explicit = render({ toolNames: ["read"] });
  assert.deepEqual(
    switches(explicit).map((row) => row.checked),
    [true, false, false],
  );
  assert.ok(explicit.includes("使用 1 / 全 3"));
});

test("アプリ側で使えない行は理由を出し、使用中でも使えないと伝える", () => {
  const html = render();
  assert.ok(html.includes("アプリ側で無効です。チェックしても使えません"));
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
  const unknown = render({
    tools: [
      { name: "serve", description: "", group: "app", available: false, reason: "brand_new" as ToolUnavailableReason },
    ],
  });
  assert.ok(unknown.includes("いまは使えません。チェックしても使えません"));
});

test("外した行だけに依存の注記を出し、使えない理由とは別の情報として併記する", () => {
  const off = render({ toolNames: ["read", "serve"] });
  assert.ok(off.includes("bash からはファイルへ書き込めます"));
  const onRead = render({ toolNames: ["bash", "serve"] });
  assert.ok(onRead.includes("スキル本文を読めなくなり"));

  const serve = render({ toolNames: ["read", "bash"] });
  assert.ok(serve.includes("組み込みスキル serve の手順はこのツールを使うため"));
  assert.ok(serve.includes("アプリ側で無効です。チェックしても使えません"));
});

test("グループの「すべて外す」は使用中の行があるグループにだけ出す", () => {
  const unspecified = render();
  const count = (html: string) => html.split(ALLOWLIST_DISABLE_GROUP_LABEL).length - 1;
  assert.equal(count(unspecified), 2, "作業ツールとアプリのツールの両方に出す");

  // アプリのツールを使っていなければ、そのグループには出さない
  const sandboxOnly = render({ toolNames: ["read", "bash"] });
  assert.equal(count(sandboxOnly), 1);
  assert.equal(render({ toolNames: [] }).includes(ALLOWLIST_DISABLE_GROUP_LABEL), false);
});

test("既定へ戻すは明示リストのときだけ出し、明示の注記も同時に出す", () => {
  assert.equal(render().includes(ALLOWLIST_RESET_LABEL), false);
  const explicit = render({ toolNames: ["read"] });
  assert.ok(explicit.includes(ALLOWLIST_RESET_LABEL));
  assert.ok(explicit.includes(TOOL_EXPLICIT_NOTE));
  assert.ok(render().includes("既定のまま"));
  assert.ok(explicit.includes("既定から変更あり"));
});

test("パネルの注記は新しい会話にだけ効くことと、アプリ側の可否を伝える", () => {
  const html = render();
  assert.ok(html.includes(TOOL_CARD_NOTE));
  assert.match(html, /新しい会話/);
});

test("一覧に無い保存名は落とさず見つからない旨を出し、保存名は増減しない", () => {
  const html = render({ toolNames: ["read", "gone"] });
  assert.ok(html.includes("見つかりません"));
  assert.ok(html.includes("gone"));
  assert.deepEqual(
    switches(html).map((row) => row.checked),
    [true, false, false],
  );
});

test("一覧を取得できないときは、行ではなく理由を出す", () => {
  const html = render({ tools: [] });
  assert.ok(html.includes(TOOL_CATALOG_UNAVAILABLE_NOTE));
  assert.equal(html.includes(TOOL_GROUP_LABELS.sandbox), false);
  assert.equal(html.includes('role="switch"'), false);
});
