// ファイルツリーのリネーム導線。出し分けは lib/fileRowMenu.ts の純関数が正で、ここでは prompt / API /
// 状態の張り替えの配線と、どの画面が canRename / readOnly を渡すかを固定する (描画の属性は fileRowMenu.test.ts)。
//   1. リネームは canRename (設定 → ファイル) のフォルダ行だけ。既定 (チャット右パネル) とファイル行・symlink 行には出ない
//   2. readOnly (スキルのファイルタブ) は行の操作ごと消える / 既存 2 画面は既定 false のまま
//   3. prompt の初期値が現在の名前で、空・未変更なら何もしない
//   4. 成功後にツリー・タブ・表示モードの経路を張り替え、失敗は親ディレクトリの行に出す
//   5. リネームを出すのは設定ツリー (FileTreePage) だけ
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fileRowActions } from "../src/lib/fileRowMenu";

const base = {
  name: "docs",
  type: "dir" as const,
  canRename: false,
  readOnly: false,
  excludeNames: [] as readonly string[],
};

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("出し分け: リネームは canRename のフォルダ行だけに、ダウンロードの後ろ・削除の前へ出す", () => {
  const renamable = fileRowActions({ ...base, canRename: true }) ?? [];
  assert.deepEqual(
    renamable.map((action) => action.kind),
    ["download", "rename", "delete"],
    "リネームの位置か順序が違う",
  );

  // 既定 (チャット右パネル) は出さない
  assert.ok(!(fileRowActions(base) ?? []).some((action) => action.kind === "rename"));
  // ファイル行は出さない (UI からは改名できない)
  assert.ok(!(fileRowActions({ ...base, type: "file", canRename: true }) ?? []).some((a) => a.kind === "rename"));
  // symlink 行は項目ごと消える
  assert.deepEqual(fileRowActions({ ...base, canRename: true, symlink: true }), []);
  // readOnly は行の操作ごと消える (スキルのファイルタブ)
  assert.equal(fileRowActions({ ...base, canRename: true, readOnly: true }), null);
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
  assert.match(fileBrowser, /canRename = false[^}]*\}: FileBrowserProps/, "canRename の既定が false でない");
  // readOnly も既定 false。渡すのはスキルのファイルタブだけで、既存 2 画面の導線は不変
  assert.match(fileBrowser, /readOnly = false[^}]*\}: FileBrowserProps/, "readOnly の既定が false でない");
  for (const screen of ["src/components/FileTreePage.tsx", "src/components/SessionFilesPanel.tsx"]) {
    assert.ok(!read(screen).includes("readOnly"), `${screen} が readOnly を渡している`);
  }
  assert.ok(read("src/components/FileTreePage.tsx").includes("canRename"), "FileTreePage が canRename を渡していない");
  assert.ok(
    !read("src/components/SessionFilesPanel.tsx").includes("canRename"),
    "チャット右パネルが canRename を渡している",
  );
  assert.ok(
    read("src/components/skill-settings/ReadOnlySkillPanel.tsx").includes("readOnly"),
    "スキルのファイルタブが読み取り専用でない",
  );
});
