import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

// FileBrowser / FilePreview は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { FileBreadcrumb } = await import("../src/components/FilePreview");

test("パンくずは root 相対の各階層を並べ、root 相対のパスで reveal できる", () => {
  const html = renderToStaticMarkup(
    createElement(FileBreadcrumb, {
      rootPath: "projects/u7agent",
      activePath: "client/src/a.ts",
      onReveal: () => {},
    }),
  );
  assert.ok(html.includes('aria-label="ファイルの場所"'), "パンくずのラベルが無い");
  // 画面 root はツリーにその行が無く押せないため出さない (全体パスは title に残す)
  assert.ok(!html.includes(">projects/u7agent<"), "画面 root が出ている");
  assert.ok(html.includes('title="projects/u7agent/client/src/a.ts"'), "全体パスの tooltip が無い");
  // 画面 root 相対の祖先とファイルは、ツリーで位置を示すボタンにする
  for (const path of ["client", "client/src", "client/src/a.ts"]) {
    assert.ok(html.includes(`title="${path} をツリーで表示"`), `${path} の reveal ボタンが無い`);
  }
  assert.ok(html.includes('aria-current="page"'), "表示中のファイルを現在の位置として示していない");
  assert.ok(html.includes(">client<") && html.includes(">src<") && html.includes(">a.ts<"), "セグメントが表示されない");
});
