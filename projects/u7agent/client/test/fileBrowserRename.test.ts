// ファイルツリーのリネーム導線。client に DOM テスト基盤が無いため、行の右端のコンポーネントだけを
// react-dom/server で描画して canRename の出し分けを固定し、配線 (prompt / API / 状態の張り替え) は
// ソース走査で固定する (fileBrowserRowTime.test.ts と同じ方針)。
//   1. 鉛筆がフォルダ行の削除ボタンの左に出る / 既定 (チャット右パネル) とファイル行・symlink 行には出ない
//   2. prompt の初期値が現在の名前で、空・未変更なら何もしない
//   3. 成功後にツリー・タブ・表示モードの経路を張り替え、失敗は親ディレクトリの行に出す
//   4. リネームを出すのは設定ツリー (FileTreePage) だけ
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

// FileBrowser は api.ts (location.origin を読む) を辿るため、node では最小の shim を置いてから読み込む
globalThis.location ??= { origin: "http://localhost" } as Location;
const { EntryRowActions } = await import("../src/components/FileBrowser");

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

function renderActions(props: { type?: "file" | "dir"; symlink?: boolean; canRename?: boolean }): string {
  return renderToStaticMarkup(
    createElement(EntryRowActions, {
      name: "docs",
      type: props.type ?? "dir",
      symlink: props.symlink,
      canRename: props.canRename ?? false,
      onRename: () => {},
      onDelete: () => {},
    }),
  );
}

test("描画: リネームの鉛筆は canRename のフォルダ行だけに、削除の左へ出す", () => {
  const renamable = renderActions({ canRename: true });
  assert.ok(renamable.includes("docs の名前を変更"), "フォルダ行に鉛筆が出ていない");
  assert.ok(renamable.includes("docs を削除"));
  assert.ok(renamable.indexOf("docs の名前を変更") < renamable.indexOf("docs を削除"), "削除の左に並べていない");

  // 既定 (チャット右パネル) はリネームの導線を出さない
  const plain = renderActions({});
  assert.ok(!plain.includes("名前を変更"));
  assert.ok(plain.includes("docs を削除"));

  // ファイル行と symlink 行はスロットだけ空けて鉛筆を出さない (時刻の右端をそろえる)
  for (const props of [{ canRename: true, type: "file" } as const, { canRename: true, symlink: true } as const]) {
    const html = renderActions(props);
    assert.ok(!html.includes("名前を変更"), JSON.stringify(props));
    assert.ok(html.includes('class="size-6 shrink-0"'), `スロットが空いていない: ${JSON.stringify(props)}`);
  }
  // symlink は削除も出さない
  assert.ok(!renderActions({ canRename: true, symlink: true }).includes("を削除"));
});

test("リネームの導線は prompt の初期値を現在の名前にして、空・未変更なら何もしない", () => {
  const source = read("src/components/FileBrowser.tsx");
  assert.match(source, /const renameRow = \(path: string, currentName: string\) => \{/, "リネームのハンドラが無い");
  assert.ok(
    source.includes("window.prompt(fileTreeRenamePrompt(path), currentName)"),
    "prompt の初期値が現在の名前でない",
  );
  assert.ok(source.includes("if (!nextName || nextName === currentName) return;"), "空・未変更で何もしない判定が無い");
  // 確認 (window.confirm) と同じく、同じ行の二重送信を弾く
  assert.ok(source.includes("renamingRef.current.has(path)"), "同じ行の二重送信を弾いていない");
});

test("リネームはサンドボックスへ委譲し、成功後にツリー・タブ・表示モードを張り替える", () => {
  const source = read("src/components/FileBrowser.tsx");
  assert.ok(source.includes("await renameEntry(fileTreeFetchPath(rootPath, path), nextName)"));
  assert.ok(source.includes("renameFileTreeEntry(prev, path, nextPath)"), "ツリーの経路を張り替えていない");
  assert.ok(source.includes("renameFileTabs(prev, path, nextPath)"), "タブの経路を張り替えていない");
  assert.ok(source.includes("renamePreviewModes(prev, path, nextPath)"), "表示モードの経路を張り替えていない");
  // 失敗は削除と同じく親ディレクトリの行に出す
  assert.ok(
    source.includes("applyFileTreeError(prev, fileTreeParentPath(path), errorText(error))"),
    "失敗の表示が親ディレクトリの行でない",
  );
  // 画面の root 相対は親 + 新しい名前で組む (応答の実パスは symlink 経由の要求でキーとずれる)
  assert.ok(source.includes("fileTreeChildPath(fileTreeParentPath(path), nextName)"), "新しい経路の組み立てが無い");
});

test("リネームを出すのは設定ツリー (FileTreePage) だけ", () => {
  const fileBrowser = read("src/components/FileBrowser.tsx");
  assert.match(fileBrowser, /canRename = false \}: FileBrowserProps/, "canRename の既定が false でない");
  assert.ok(read("src/components/FileTreePage.tsx").includes("canRename"), "FileTreePage が canRename を渡していない");
  assert.ok(
    !read("src/components/SessionFilesPanel.tsx").includes("canRename"),
    "チャット右パネルが canRename を渡している",
  );
});
