// ファイルツリーの状態更新 (#1284)。DOM を使わず、開閉・子のマージ・エラー保持の遷移だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeState,
  fileTreeChildPath,
  invalidateFileTree,
  pendingFileTreeDirectories,
  toggleFileTreeDirectory,
  type FileTreeState,
} from "../src/lib/fileTree";
import type { FileEntry } from "../src/types";

const dir = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, type: "dir", ...extra });
const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, type: "file", ...extra });

/** root を取得済みにして、指定パスを取得済みにする */
function loaded(entries: Record<string, FileEntry[]>): FileTreeState {
  let state = createFileTreeState();
  for (const [path, listing] of Object.entries(entries)) {
    state = applyFileTreeListing(state, path, { entries: listing, truncated: false });
  }
  return state;
}

test("初期状態は root だけを開いた未取得にする", () => {
  const state = createFileTreeState();
  assert.deepEqual(state, { ".": { open: true, loading: false } });
  assert.deepEqual(pendingFileTreeDirectories(state), ["."]);
});

test("子のキーは root 直下とネストで変わる", () => {
  assert.equal(fileTreeChildPath(".", "src"), "src");
  assert.equal(fileTreeChildPath("src", "client"), "src/client");
});

test("開閉を切り替えても取得済みの子は保持する", () => {
  const state = loaded({ ".": [dir("src"), file("README.md")], src: [file("index.ts")] });
  const opened = { ...state, src: { ...state.src, open: true } };
  const closed = toggleFileTreeDirectory(opened, "src");
  assert.equal(closed.src.open, false);
  assert.deepEqual(closed.src.children, [file("index.ts")]);
  // 閉じている間は取得対象にならない
  assert.deepEqual(pendingFileTreeDirectories(closed), []);
  const reopened = toggleFileTreeDirectory(closed, "src");
  assert.equal(reopened.src.open, true);
  assert.deepEqual(pendingFileTreeDirectories(reopened), []);
  // 未取得のディレクトリを開くと取得対象になる
  const fresh = toggleFileTreeDirectory(loaded({ ".": [dir("docs")] }), "docs");
  assert.deepEqual(pendingFileTreeDirectories(fresh), ["docs"]);
});

test("取得結果は子と truncated を保存し、表示順で未取得を拾う", () => {
  const state = applyFileTreeListing(createFileTreeState(), ".", {
    entries: [dir("src"), dir("docs"), file("README.md")],
    truncated: true,
  });
  assert.equal(state["."].loading, false);
  assert.equal(state["."].truncated, true);
  assert.deepEqual(state["."].children, [dir("src"), dir("docs"), file("README.md")]);
  // ファイルは取得対象にならない
  assert.deepEqual(pendingFileTreeDirectories(state), []);
  const expanded = toggleFileTreeDirectory(state, "src");
  assert.deepEqual(pendingFileTreeDirectories(expanded), ["src"]);
});

test("親を再取得しても、残った子孫の開閉と取得結果は保持する", () => {
  let state = loaded({ ".": [dir("src")], src: [dir("components")], "src/components": [file("Button.tsx")] });
  state = { ...state, "src/components": { ...state["src/components"], open: true } };
  const merged = applyFileTreeListing(state, ".", { entries: [dir("src"), file("new.md")], truncated: false });
  assert.deepEqual(merged["src"].children, [dir("components")]);
  assert.deepEqual(merged["src/components"].children, [file("Button.tsx")]);
  assert.equal(merged["src/components"].open, true);
});

test("消えた子孫の状態は捨てる", () => {
  const state = loaded({ ".": [dir("src"), dir("docs")], src: [file("index.ts")], docs: [file("guide.md")] });
  const merged = applyFileTreeListing(state, ".", { entries: [dir("src")], truncated: false });
  assert.ok(merged.src);
  assert.equal(merged.docs, undefined);
  // 残った子の配下は維持する
  assert.deepEqual(merged["src"].children, [file("index.ts")]);
});

test("取得中は再要求せず、エラーは同じディレクトリにだけ残る", () => {
  const state = beginFileTreeLoad(createFileTreeState(), ".");
  assert.equal(state["."].loading, true);
  assert.deepEqual(pendingFileTreeDirectories(state), []);

  const failed = applyFileTreeError(state, ".", "Path not found: /workspace");
  assert.equal(failed["."].loading, false);
  assert.equal(failed["."].error, "Path not found: /workspace");
  assert.equal(failed["."].children, undefined);
  assert.deepEqual(pendingFileTreeDirectories(failed), [], "エラーのまま自動再取得しない");

  // 再試行するとエラーが消えて取得対象に戻る
  const retried = beginFileTreeLoad(failed, ".");
  assert.equal(retried["."].error, undefined);
  assert.deepEqual(pendingFileTreeDirectories(retried), []);
  assert.equal(retried["."].loading, true);

  // 別のディレクトリの失敗は他を壊さない
  const tree = loaded({ ".": [dir("src"), dir("docs")], src: [file("index.ts")] });
  const partial = applyFileTreeError({ ...tree, docs: { open: true, loading: true } }, "docs", "Not a directory");
  assert.deepEqual(partial.src.children, [file("index.ts")]);
  assert.equal(partial.docs.error, "Not a directory");
  assert.equal(partial["."].error, undefined);
});

test("再読み込みは取得済みの子とエラーを捨て、開閉と取得中を保つ", () => {
  let state = loaded({ ".": [dir("src")], src: [file("index.ts")] });
  state = { ...state, src: { ...state.src, open: true }, "src/keep": { open: true, loading: false } };
  state = applyFileTreeError(state, "src", "boom");
  const reloaded = invalidateFileTree(state);
  assert.equal(reloaded["."].open, true);
  assert.equal(reloaded["."].children, undefined);
  assert.equal(reloaded["src"].open, true);
  assert.equal(reloaded["src"].children, undefined);
  assert.equal(reloaded["src"].error, undefined);
  assert.equal(reloaded["src/keep"].open, true, "開閉は保つ (描画は到達した子だけ)");
  assert.deepEqual(pendingFileTreeDirectories(reloaded), ["."], "親から順に取り直す");
  // 取得中は残すので、解決前の再読み込みで二重に要求しない
  const loading = beginFileTreeLoad(reloaded, ".");
  assert.deepEqual(
    pendingFileTreeDirectories(invalidateFileTree(loading)),
    [],
    "取得中の再読み込みでは要求し直さない (進行中の結果を待つ)",
  );
});
