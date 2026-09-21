// ProjectStore と cwd の正規化・検証 (HTTP 層は api.test.ts)。実ファイルシステムは触らない。

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectCwd, normalizeWorkspacePath, ProjectStore, resolveWorkspaceCwd } from "../src/projects";
import { ProjectSchema } from "../src/schema";

function isBadRequest(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 400;
}

test("normalizes a relative workspace path to a slash-separated form", () => {
  assert.equal(normalizeWorkspacePath("a/b"), "a/b");
  assert.equal(normalizeWorkspacePath("a//b/"), "a/b");
  assert.equal(normalizeWorkspacePath("./a/./b"), "a/b");
  assert.equal(normalizeWorkspacePath("nested/deep/worktree"), "nested/deep/worktree");
  // 空文字は root 自身 (未所属セッションの作業場所)
  assert.equal(normalizeWorkspacePath(""), "");
  assert.equal(normalizeWorkspacePath("."), "");
});

test("rejects absolute paths and parent traversal", () => {
  for (const value of ["/etc", "/", "..", "../outside", "a/../../b", "a/..", "cwd/../.."]) {
    assert.throws(() => normalizeWorkspacePath(value), isBadRequest, value);
  }
});

test("a project cwd cannot be the workspace root", () => {
  assert.equal(normalizeProjectCwd("proj"), "proj");
  assert.equal(normalizeProjectCwd("a/b/"), "a/b");
  assert.throws(() => normalizeProjectCwd(""), isBadRequest);
  assert.throws(() => normalizeProjectCwd("."), isBadRequest);
  assert.throws(() => normalizeProjectCwd("./"), isBadRequest);
});

test("an app directory path cannot be registered as a project", () => {
  for (const value of [".u7agent", ".u7agent/", "./.u7agent", ".u7agent/uploads/a.png"]) {
    assert.throws(() => normalizeProjectCwd(value), isBadRequest, value);
  }
  // 名前が同じでも別ディレクトリは登録できる (.u7agent-other など)
  assert.equal(normalizeProjectCwd(".u7agent-other"), ".u7agent-other");
});

test("resolves a session cwd against the workspace root", () => {
  assert.deepEqual(resolveWorkspaceCwd("/workspace", "proj/sub"), {
    relative: "proj/sub",
    absolute: "/workspace/proj/sub",
  });
  // 未所属は root 自身
  assert.deepEqual(resolveWorkspaceCwd("/workspace", ""), { relative: "", absolute: "/workspace" });
  assert.throws(() => resolveWorkspaceCwd("/workspace", "../escape"), isBadRequest);
  assert.throws(() => resolveWorkspaceCwd("/workspace", "/etc"), isBadRequest);
});

test("stores projects in creation order and detects duplicate cwd", () => {
  const store = new ProjectStore();
  const first = store.create({ cwd: "proj-a" });
  const second = store.create({ cwd: "nested/proj-b", name: " 表示名 " });

  assert.equal(first.name, "proj-a", "name defaults to the cwd basename");
  assert.equal(second.name, "表示名");
  assert.deepEqual(
    store.list().map((project) => project.cwd),
    ["proj-a", "nested/proj-b"],
  );
  assert.equal(store.get(first.id), first);
  assert.equal(store.findByCwd("proj-a"), first);

  // 同じディレクトリを 2 つのプロジェクトにしない
  assert.throws(
    () => store.create({ cwd: "proj-a" }),
    (error: Error & { statusCode?: number }) => error.statusCode === 409,
  );
  assert.equal(store.list().length, 2);

  assert.equal(store.remove(first.id), true);
  assert.equal(store.remove(first.id), false);
  assert.equal(store.get(first.id), undefined);
  // 削除した cwd は登録し直せる
  assert.equal(store.create({ cwd: "proj-a" }).cwd, "proj-a");
});

test("a stored project matches the API DTO", () => {
  const store = new ProjectStore();
  const project = store.create({ cwd: "proj" });
  assert.deepEqual(Object.keys(project).sort(), ["createdAt", "cwd", "id", "name"]);
  assert.equal(ProjectSchema.safeParse(project).success, true);
});
