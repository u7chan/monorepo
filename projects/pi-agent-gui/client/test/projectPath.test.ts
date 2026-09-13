// プロジェクトのディレクトリ選択で使う root 相対パスの組み立て。DOM を使わず純関数だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { parentWorkspacePath, projectChildPath, workspaceBaseName } from "../src/lib/projectPath";

test("子パスは root 直下とネストで変わり、前後の空白は落とす", () => {
  assert.equal(projectChildPath(".", "client"), "client");
  assert.equal(projectChildPath("projects", "pi-agent-gui"), "projects/pi-agent-gui");
  assert.equal(projectChildPath(".", "  client  "), "client");
});

test("上の階層は root より上へ行かない", () => {
  assert.equal(parentWorkspacePath("a/b/c"), "a/b");
  assert.equal(parentWorkspacePath("a"), ".");
  assert.equal(parentWorkspacePath("."), ".");
});

test("末尾のセグメントは登録時の既定名になり、root は空文字になる", () => {
  assert.equal(workspaceBaseName("projects/pi-agent-gui"), "pi-agent-gui");
  assert.equal(workspaceBaseName("projects"), "projects");
  assert.equal(workspaceBaseName("."), "");
});
