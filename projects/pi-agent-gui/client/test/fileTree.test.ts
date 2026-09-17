// ファイルツリーの状態更新。DOM を使わず、開閉・子のマージ・エラー保持の遷移だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeState,
  createFileTreeStateFromDirectories,
  fileTreeChildPath,
  fileTreeDirectoryState,
  fileTreeFetchPath,
  invalidateFileTree,
  normalizeFileTreeRoot,
  openFileTreeDirectories,
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

test("画面の root は root 相対に正規化し、絶対パスはワークスペース root として扱う", () => {
  assert.equal(normalizeFileTreeRoot(""), ".", '未所属 (root) は "" で渡る');
  assert.equal(normalizeFileTreeRoot("."), ".");
  assert.equal(normalizeFileTreeRoot("docs"), "docs");
  assert.equal(normalizeFileTreeRoot("docs/api"), "docs/api");
  assert.equal(normalizeFileTreeRoot("docs/"), "docs", "末尾の区切りは落とす");
  // health.cwd (ワークスペース root の絶対パス) が渡る経路。GET /api/files の path は root 相対だけを受ける
  assert.equal(normalizeFileTreeRoot("/home/u7dev/workspace"), ".");
  assert.equal(normalizeFileTreeRoot("C:\\workspace"), ".");
});

test("tree のパスは画面の root を前置して GET /api/files の path になる", () => {
  // 未所属 (root) と root 自身の取得は path="." のまま
  assert.equal(fileTreeFetchPath("", "."), ".");
  assert.equal(fileTreeFetchPath("docs", "."), "docs", "プロジェクトのセッションは所属ディレクトリが root になる");
  assert.equal(fileTreeFetchPath("/home/u7dev/workspace", "."), ".");
  // 配下の展開は画面の root を前置する
  assert.equal(fileTreeFetchPath(".", "docs"), "docs");
  assert.equal(fileTreeFetchPath("docs", "api.md"), "docs/api.md");
  assert.equal(fileTreeFetchPath("docs/api", "src"), "docs/api/src");
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

// パスにはファイル名がそのまま入るため、Object.prototype の名前も同じように扱える必要がある
test("Object.prototype の名前のディレクトリも own プロパティとして取得する", () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const state = loaded({ ".": [dir(name)], [name]: [file("child.ts")] });
    assert.equal(Object.hasOwn(state, name), true, name);
    assert.equal(Object.getPrototypeOf(state), Object.prototype, name);
    assert.deepEqual(fileTreeDirectoryState(state, name)?.children, [file("child.ts")], name);
  }
});

test("未取得の Object.prototype の名前でも既定の状態から始める", () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const state = toggleFileTreeDirectory(createFileTreeState(), name);
    assert.deepEqual(fileTreeDirectoryState(state, name), { open: true, loading: false }, name);
    assert.equal(Object.getPrototypeOf(state), Object.prototype, name);
  }
});

test("__proto__ という名前のディレクトリは再読み込み後も再取得の対象に残る", () => {
  // オブジェクトリテラルの `__proto__:` はプロトタイプの設定になるため、computed key で渡す
  let state = loaded({ ".": [dir("__proto__")], ["__proto__"]: [file("child.ts")] });
  state = toggleFileTreeDirectory(state, "__proto__");
  assert.deepEqual(fileTreeDirectoryState(state, "__proto__")?.children, [file("child.ts")]);

  const reloaded = invalidateFileTree(state);
  assert.equal(Object.hasOwn(reloaded, "__proto__"), true, "再読み込みで状態を落とさない");

  // 再読み込みは root から取り直すため、root の一覧が戻った時点で開いたままの子が要求対象になる
  const refetched = applyFileTreeListing(reloaded, ".", { entries: [dir("__proto__")], truncated: false });
  assert.deepEqual(pendingFileTreeDirectories(refetched), ["__proto__"], "開いたまま取り直す");
});

// 保存値からの復元。保存するのは開いているディレクトリだけで、children は復帰時に取り直す
test("開いているディレクトリだけを保存対象にし、root は含めない", () => {
  let state = loaded({ ".": [dir("a"), dir("b")], a: [], b: [] });
  state = toggleFileTreeDirectory(state, "a");
  state = toggleFileTreeDirectory(state, "b");
  state = toggleFileTreeDirectory(state, "a");
  assert.deepEqual(openFileTreeDirectories(state), ["b"], "閉じた a は含めない");
  assert.deepEqual(openFileTreeDirectories(createFileTreeState()), [], "root は常に開いているので含めない");
});

test("保存した展開状態からは root と開いたディレクトリだけを復元する", () => {
  const state = createFileTreeStateFromDirectories(["src", "src/components"]);
  assert.deepEqual(state, {
    ".": { open: true, loading: false },
    src: { open: true, loading: false },
    "src/components": { open: true, loading: false },
  });
  // children は保存していないので、取得は既存の「可視の親から子へ」の経路で親から順に始まる
  assert.deepEqual(pendingFileTreeDirectories(state), ["."]);
});

test("親を閉じた子の open は保存し、復元しても親を勝手に開かない", () => {
  const restored = createFileTreeStateFromDirectories(["a/b"]);
  assert.equal(fileTreeDirectoryState(restored, "a"), undefined, "親は閉じたまま (未取得 = 閉)");
  assert.equal(fileTreeDirectoryState(restored, "a/b")?.open, true, "子の open は保存どおり");
  // 可視でない子は取りに行かない。親を開いた時点で開いたままの子が要求対象になる
  const rootLoaded = applyFileTreeListing(restored, ".", { entries: [dir("a")], truncated: false });
  assert.deepEqual(pendingFileTreeDirectories(rootLoaded), []);
  const aLoaded = applyFileTreeListing(toggleFileTreeDirectory(rootLoaded, "a"), "a", {
    entries: [dir("b")],
    truncated: false,
  });
  assert.deepEqual(pendingFileTreeDirectories(aLoaded), ["a/b"]);
});

test("truncated の一覧では未掲載の枝が落ちる (完全な復元は保証しない)", () => {
  const restored = createFileTreeStateFromDirectories(["src", "docs"]);
  const truncated = applyFileTreeListing(restored, ".", { entries: [dir("src")], truncated: true });
  assert.equal(fileTreeDirectoryState(truncated, "src")?.open, true, "掲載された枝の open は残る");
  assert.equal(fileTreeDirectoryState(truncated, "docs"), undefined, "一覧に無い枝は落ちる");
});

test("Object.prototype の名前のディレクトリも保存値から復元する", () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const state = createFileTreeStateFromDirectories([name]);
    assert.equal(Object.hasOwn(state, name), true, name);
    assert.equal(Object.getPrototypeOf(state), Object.prototype, name);
    assert.equal(fileTreeDirectoryState(state, name)?.open, true, name);
    assert.deepEqual(openFileTreeDirectories(state), [name], name);
  }
});
