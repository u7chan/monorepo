// ファイルツリーの状態更新。DOM を使わず、開閉・子のマージ・エラー保持の遷移だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFileTreeError,
  applyFileTreeListing,
  beginFileTreeLoad,
  createFileTreeState,
  createFileTreeStateFromDirectories,
  fileTreeAncestorPaths,
  fileTreeBreadcrumbs,
  fileTreeChildPath,
  fileTreeDeleteConfirm,
  fileTreeDeleteDirectoryConfirm,
  fileTreeDirectoryState,
  fileTreeEntryFor,
  fileTreeFetchPath,
  fileTreeRenamePrompt,
  invalidateFileTree,
  normalizeFileTreeRoot,
  openFileTreeAncestors,
  openFileTreeDirectories,
  pendingFileTreeDirectories,
  pruneFileTreeSubtree,
  removeFileTreeEntry,
  renameFileTreeEntry,
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

test("削除の確認文言はツリーに見えている root 相対パスを出す", () => {
  // 設定 → ファイル はワークスペース root 相対、チャット右パネルはセッションの作業フォルダ相対を渡す
  assert.equal(
    fileTreeDeleteConfirm(".u7agent/sessions/3a7bfba36f/uploads/shot.png"),
    "「.u7agent/sessions/3a7bfba36f/uploads/shot.png」を削除しますか？この操作は取り消せません。",
  );
  assert.equal(
    fileTreeDeleteConfirm("uploads/shot.png"),
    "「uploads/shot.png」を削除しますか？この操作は取り消せません。",
  );
  assert.equal(fileTreeDeleteConfirm("note.txt"), "「note.txt」を削除しますか？この操作は取り消せません。");
});

test("ディレクトリ削除の確認文言は配下ごと消えることを示す", () => {
  assert.equal(
    fileTreeDeleteDirectoryConfirm("uploads/3a7bfba36f"),
    "「uploads/3a7bfba36f」と配下のファイルをすべて削除しますか？この操作は取り消せません。",
  );
  assert.equal(
    fileTreeDeleteDirectoryConfirm("src/components"),
    "「src/components」と配下のファイルをすべて削除しますか？この操作は取り消せません。",
  );
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

test("親を閉じると配下の全子孫も閉じ、開き直しても子孫は閉じたまま", () => {
  let state = loaded({
    ".": [dir("a"), dir("ab")],
    a: [dir("b"), file("x.txt")],
    "a/b": [dir("c")],
    "a/b/c": [file("deep.txt")],
    ab: [file("keep.txt")],
  });
  for (const path of ["a", "a/b", "a/b/c", "ab"]) {
    state = toggleFileTreeDirectory(state, path);
  }
  assert.deepEqual(openFileTreeDirectories(state), ["a", "a/b", "a/b/c", "ab"]);

  const closed = toggleFileTreeDirectory(applyFileTreeError(state, "a/b/c", "取得できません"), "a");
  assert.equal(closed.a.open, false);
  assert.equal(fileTreeDirectoryState(closed, "a/b")?.open, false, "子も閉じる");
  assert.equal(fileTreeDirectoryState(closed, "a/b/c")?.open, false, "孫も閉じる");
  assert.equal(fileTreeDirectoryState(closed, "ab")?.open, true, "接頭辞が同じ別パスは巻き込まない");
  assert.deepEqual(openFileTreeDirectories(closed), ["ab"]);
  // 取得結果とエラーは残すので、開き直しで再取得は起きない
  assert.deepEqual(fileTreeDirectoryState(closed, "a/b")?.children, [dir("c")]);
  assert.equal(fileTreeDirectoryState(closed, "a/b/c")?.error, "取得できません", "エラーも保持する");
  assert.deepEqual(pendingFileTreeDirectories(closed), [], "閉じた枝からは取りに行かない");

  const reopened = toggleFileTreeDirectory(closed, "a");
  assert.equal(reopened.a.open, true);
  assert.equal(fileTreeDirectoryState(reopened, "a/b")?.open, false, "開き直しても子孫は閉じたまま");
  assert.equal(fileTreeDirectoryState(reopened, "a/b/c")?.open, false);
  assert.deepEqual(pendingFileTreeDirectories(reopened), [], "取得済みの子を再取得しない");
});

test("取得中に閉じても、後着した一覧の応答で開きは復活しない", () => {
  let state = loaded({ ".": [dir("big")] });
  state = beginFileTreeLoad(toggleFileTreeDirectory(state, "big"), "big");
  assert.equal(fileTreeDirectoryState(state, "big")?.loading, true);

  const closed = toggleFileTreeDirectory(state, "big");
  assert.equal(fileTreeDirectoryState(closed, "big")?.open, false);

  // 応答は loading を落として取得結果を入れるが、閉じた open は保持する
  const landed = applyFileTreeListing(closed, "big", { entries: [dir("sub")], truncated: false });
  assert.equal(fileTreeDirectoryState(landed, "big")?.open, false, "閉じた枝が応答で開かない");
  assert.equal(fileTreeDirectoryState(landed, "big")?.loading, false);
  assert.deepEqual(fileTreeDirectoryState(landed, "big")?.children, [dir("sub")]);
  assert.deepEqual(pendingFileTreeDirectories(landed), []);

  // 開き直すと、後着していた一覧がそのまま使える
  const reopened = toggleFileTreeDirectory(landed, "big");
  assert.equal(reopened.big.open, true);
  assert.deepEqual(pendingFileTreeDirectories(reopened), [], "後着した一覧で再取得しない");
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

test("__proto__ の名前でも閉じる遷移はプロトタイプを壊さずに子孫を閉じる", () => {
  let state = loaded({
    ".": [dir("__proto__"), dir("__proto__x")],
    ["__proto__"]: [dir("child")],
    "__proto__/child": [file("x.ts")],
    __proto__x: [file("keep.ts")],
  });
  state = toggleFileTreeDirectory(state, "__proto__");
  state = toggleFileTreeDirectory(state, "__proto__/child");
  state = toggleFileTreeDirectory(state, "__proto__x");

  const closed = toggleFileTreeDirectory(state, "__proto__");
  assert.equal(Object.getPrototypeOf(closed), Object.prototype, "プロトタイプを壊す");
  assert.equal(fileTreeDirectoryState(closed, "__proto__")?.open, false);
  assert.equal(fileTreeDirectoryState(closed, "__proto__/child")?.open, false, "子も閉じる");
  assert.equal(fileTreeDirectoryState(closed, "__proto__/child")?.loading, false);
  assert.deepEqual(fileTreeDirectoryState(closed, "__proto__/child")?.children, [file("x.ts")]);
  assert.equal(fileTreeDirectoryState(closed, "__proto__x")?.open, true, "接頭辞が同じ別パスは巻き込まない");
  assert.deepEqual(openFileTreeDirectories(closed), ["__proto__x"]);
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

test("祖先が保存集合に無い展開パスは復元せず、配列の順序には依存しない", () => {
  // 旧仕様の保存値。親を勝手に開かず、孤立した子孫も開いた状態として復元しない
  const legacy = createFileTreeStateFromDirectories(["a/b"]);
  assert.equal(fileTreeDirectoryState(legacy, "a"), undefined, "親を勝手に開かない (未取得 = 閉)");
  assert.equal(fileTreeDirectoryState(legacy, "a/b"), undefined, "孤立した子孫も開いた状態にしない");
  assert.deepEqual(openFileTreeDirectories(legacy), []);

  // 子孫が先に並んでいても、祖先がそろっていれば復元する
  const ordered = createFileTreeStateFromDirectories(["a/b/c", "a/b", "a"]);
  assert.equal(fileTreeDirectoryState(ordered, "a")?.open, true);
  assert.equal(fileTreeDirectoryState(ordered, "a/b")?.open, true);
  assert.equal(fileTreeDirectoryState(ordered, "a/b/c")?.open, true);
  assert.deepEqual(openFileTreeDirectories(ordered).sort(), ["a", "a/b", "a/b/c"]);

  // 接頭辞が同じ別パスとその配下は、それぞれの祖先がそろっているかで決まる
  const mixed = createFileTreeStateFromDirectories(["ab", "ab/child", "a"]);
  assert.deepEqual(openFileTreeDirectories(mixed).sort(), ["a", "ab", "ab/child"]);
  const partial = createFileTreeStateFromDirectories(["ab/child", "ab"]);
  assert.equal(fileTreeDirectoryState(partial, "ab")?.open, true);
  assert.equal(fileTreeDirectoryState(partial, "ab/child")?.open, true);
  assert.equal(fileTreeDirectoryState(partial, "a"), undefined);
});

test("閉じた枝の子孫は保存対象から外れ、復元して開いても子孫は閉じている", () => {
  let state = loaded({
    ".": [dir("a"), dir("b")],
    a: [dir("sub")],
    "a/sub": [file("x.ts")],
    b: [file("y.ts")],
  });
  state = toggleFileTreeDirectory(state, "a");
  state = toggleFileTreeDirectory(state, "a/sub");
  state = toggleFileTreeDirectory(state, "b");
  assert.deepEqual(openFileTreeDirectories(state), ["a", "a/sub", "b"]);

  const closed = toggleFileTreeDirectory(state, "a");
  const saved = openFileTreeDirectories(closed);
  assert.deepEqual(saved, ["b"], "閉じた枝の子孫は保存に含めない");

  // 保存値を復元して親を開き直しても、子孫は保存対象に無いので閉じたまま
  const restored = applyFileTreeListing(createFileTreeStateFromDirectories(saved), ".", {
    entries: [dir("a"), dir("b")],
    truncated: false,
  });
  assert.equal(fileTreeDirectoryState(restored, "a"), undefined, "閉じた親は復元しない");
  assert.equal(fileTreeDirectoryState(restored, "a/sub"), undefined, "子孫も復元しない");
  assert.equal(fileTreeDirectoryState(restored, "b")?.open, true, "別の枝の展開は維持する");

  const reopened = applyFileTreeListing(toggleFileTreeDirectory(restored, "a"), "a", {
    entries: [dir("sub")],
    truncated: false,
  });
  assert.equal(fileTreeDirectoryState(reopened, "a/sub"), undefined, "親を開いても子孫は閉じたまま");
  assert.deepEqual(openFileTreeDirectories(reopened).sort(), ["a", "b"]);
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

test("Object.prototype の名前でも孤立した子孫は復元せず、own プロパティのまま復元する", () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    // 祖先が保存集合に無い子孫は、名前でプロトタイプを壊さずに落とす
    const orphan = createFileTreeStateFromDirectories([`${name}/child`]);
    assert.deepEqual(orphan, { ".": { open: true, loading: false } }, name);
    assert.equal(Object.getPrototypeOf(orphan), Object.prototype, name);

    // 祖先がそろっていれば、子孫も own プロパティのまま復元する
    const state = createFileTreeStateFromDirectories([`${name}/child`, name]);
    assert.equal(Object.getPrototypeOf(state), Object.prototype, name);
    assert.equal(fileTreeDirectoryState(state, name)?.open, true, name);
    assert.equal(fileTreeDirectoryState(state, `${name}/child`)?.open, true, name);
    assert.deepEqual(openFileTreeDirectories(state).sort(), [name, `${name}/child`], name);
  }
});

// ディレクトリ削除後の状態更新。削除した枝の中だけを落とし、接頭辞が同じ別ディレクトリと親の行は残す
test("prune は削除したディレクトリ自身と配下だけを落とす", () => {
  let state = loaded({
    ".": [dir("a"), dir("ab"), file("a.txt")],
    a: [dir("deep")],
    "a/deep": [file("x.txt")],
    ab: [file("keep.txt")],
  });
  state = { ...state, a: { ...state.a, open: true }, "a/deep": { ...state["a/deep"], open: true } };

  const pruned = pruneFileTreeSubtree(state, "a");
  assert.equal(fileTreeDirectoryState(pruned, "a"), undefined);
  assert.equal(fileTreeDirectoryState(pruned, "a/deep"), undefined);
  // 受け入れ条件: `a` の削除で接頭辞が同じ `ab` を巻き込まない (`a.txt` のようなファイル名も同様)
  assert.deepEqual(fileTreeDirectoryState(pruned, "ab")?.children, [file("keep.txt")]);
  assert.deepEqual(pruned["."].children, [dir("a"), dir("ab"), file("a.txt")], "親の行は removeFileTreeEntry が落とす");
  assert.equal(pruned["."].open, true);

  // 行と状態を続けて適用すると、削除した枝が丸ごと消える
  const applied = removeFileTreeEntry(pruned, "a");
  assert.deepEqual(applied["."].children, [dir("ab"), file("a.txt")]);
  assert.equal(fileTreeDirectoryState(applied, "a"), undefined);
});

test("配下に該当が無い prune は同じ object を返す", () => {
  const state = loaded({ ".": [dir("a")], b: [file("x.txt")] });
  assert.equal(pruneFileTreeSubtree(state, "a"), state, "未取得のディレクトリ");
  assert.equal(pruneFileTreeSubtree(state, "ab"), state, "接頭辞が同じだけの別パス");
  assert.equal(pruneFileTreeSubtree(state, "b/x.txt"), state, "ファイルのパス");
});

// パスにはファイル名がそのまま入るため、prune も own プロパティの契約を壊してはならない
test("__proto__ という名前のディレクトリと子孫を prune してもプロトタイプを壊さない", () => {
  let state = loaded({ ".": [dir("__proto__")], ["__proto__"]: [dir("child")], "__proto__/child": [file("x.ts")] });
  state = toggleFileTreeDirectory(state, "__proto__");
  state = toggleFileTreeDirectory(state, "__proto__/child");

  const pruned = pruneFileTreeSubtree(state, "__proto__");
  assert.equal(Object.hasOwn(pruned, "__proto__"), false);
  assert.equal(Object.hasOwn(pruned, "__proto__/child"), false);
  assert.equal(Object.getPrototypeOf(pruned), Object.prototype);
  // 削除した枝以外は own プロパティのまま残る
  const kept = pruneFileTreeSubtree(loaded({ ".": [dir("keep")], keep: [file("y.ts")] }), "__proto__");
  assert.equal(Object.hasOwn(kept, "keep"), true);
  assert.deepEqual(fileTreeDirectoryState(kept, "keep")?.children, [file("y.ts")]);
});

// 削除後の一覧更新。該当行を落とすだけで、他のディレクトリと子孫の状態は触らない
test("削除した行だけを落とし、他の行と子孫の状態は保持する", () => {
  let state = loaded({
    ".": [file("note.txt"), dir("src")],
    src: [file("keep.ts"), file("gone.ts")],
    "src/components": [file("Button.tsx")],
  });
  state = toggleFileTreeDirectory(state, "src");
  state = toggleFileTreeDirectory(state, "src/components");

  const removed = removeFileTreeEntry(state, "note.txt");
  assert.deepEqual(removed["."].children, [dir("src")]);
  assert.deepEqual(removed.src.children, [file("keep.ts"), file("gone.ts")], "他のディレクトリは触らない");
  assert.deepEqual(removed["src/components"].children, [file("Button.tsx")], "子孫の状態は保持する");
  assert.equal(removed["src/components"].open, true);

  // ネストしたファイルも親の一覧から落ちる
  const nested = removeFileTreeEntry(removed, "src/gone.ts");
  assert.deepEqual(nested.src.children, [file("keep.ts")]);
  assert.deepEqual(nested["src/components"].children, [file("Button.tsx")]);
});

test("該当行が無い削除では同じ object を返す", () => {
  const state = loaded({ ".": [file("note.txt")], src: [file("keep.ts")] });
  assert.equal(removeFileTreeEntry(state, "missing.txt"), state, "一覧に無い行");
  assert.equal(removeFileTreeEntry(state, "src"), state, "ディレクトリは対象外");
  assert.equal(removeFileTreeEntry(state, "docs/note.txt"), state, "未取得のディレクトリ");
});

test("削除した状態は再読み込みをまたいでも、再取得した一覧を正本にする", () => {
  // 削除は親の一覧を差し替えるだけなので、再読み込み (invalidateFileTree) 後は
  // 既存の「親から順に取り直す」経路に乗る。再取得した一覧に含まれなければ行は戻らない
  let state = loaded({ ".": [file("note.txt"), dir("src")], src: [file("keep.ts")] });
  state = { ...state, src: { ...state.src, open: true } };
  const removed = removeFileTreeEntry(state, "note.txt");
  const reloaded = invalidateFileTree(removed);
  assert.equal(reloaded["src"].open, true, "開閉は保つ");
  assert.equal(reloaded["."].children, undefined, "再読み込みは親の一覧も捨てる");

  const refetched = applyFileTreeListing(reloaded, ".", { entries: [dir("src")], truncated: false });
  assert.deepEqual(refetched["."].children, [dir("src")], "削除した行は戻らない");
  assert.deepEqual(pendingFileTreeDirectories(refetched), ["src"], "開いた子は取り直す");
});

// リネーム後の状態更新。名前を差し替えて配下のキーを移し、開閉と取得済みの子はそのまま残す
test("リネームの入力の見出しはツリーに見えている root 相対パスを出す", () => {
  assert.equal(
    fileTreeRenamePrompt(".u7agent/sessions/3a7bfba36f/uploads"),
    "「.u7agent/sessions/3a7bfba36f/uploads」の新しい名前を入力してください。",
  );
  assert.equal(fileTreeRenamePrompt("docs"), "「docs」の新しい名前を入力してください。");
});

test("リネームは親の行の名前を差し替え、配下のキーと開閉・取得済みの子を移す", () => {
  let state = loaded({
    ".": [dir("a"), dir("ab"), file("a.txt")],
    a: [dir("deep"), file("x.txt")],
    "a/deep": [file("y.txt")],
    ab: [file("keep.txt")],
  });
  state = toggleFileTreeDirectory(state, "a");
  state = toggleFileTreeDirectory(state, "a/deep");

  const renamed = renameFileTreeEntry(state, "a", "renamed");
  assert.deepEqual(renamed["."].children, [dir("renamed"), dir("ab"), file("a.txt")]);
  assert.deepEqual(renamed.renamed.children, [dir("deep"), file("x.txt")], "取得済みの子は再取得しない");
  assert.deepEqual(renamed["renamed/deep"].children, [file("y.txt")]);
  assert.equal(renamed.renamed.open, true, "開いている階層は開いたまま");
  assert.equal(renamed["renamed/deep"].open, true);
  assert.equal(fileTreeDirectoryState(renamed, "a"), undefined, "旧キーは残さない");
  assert.equal(fileTreeDirectoryState(renamed, "a/deep"), undefined);
  // 受け入れ条件: `a` の改名で接頭辞が同じ `ab` を巻き込まない
  assert.deepEqual(renamed.ab.children, [file("keep.txt")]);
  assert.deepEqual(openFileTreeDirectories(renamed), ["renamed", "renamed/deep"]);
});

test("リネームはネストした行とファイル行でも親の一覧だけを差し替える", () => {
  let state = loaded({
    ".": [dir("src")],
    src: [dir("components"), file("gone.ts")],
    "src/components": [file("Button.tsx")],
  });
  state = toggleFileTreeDirectory(state, "src");

  const nested = renameFileTreeEntry(state, "src/components", "src/ui");
  assert.deepEqual(nested.src.children, [dir("ui"), file("gone.ts")]);
  assert.deepEqual(nested["src/ui"].children, [file("Button.tsx")]);
  assert.equal(fileTreeDirectoryState(nested, "src/components"), undefined);
  assert.equal(nested.src.open, true);

  const renamedFile = renameFileTreeEntry(nested, "src/gone.ts", "src/keep.ts");
  assert.deepEqual(renamedFile.src.children, [dir("ui"), file("keep.ts")]);
  assert.deepEqual(renamedFile["src/ui"].children, [file("Button.tsx")], "他のディレクトリは触らない");
});

test("リネームは該当が無ければ同じ object を返し、未取得の親の行は触らない", () => {
  const state = loaded({ ".": [dir("src")], src: [file("keep.ts")] });
  assert.equal(renameFileTreeEntry(state, "src/keep.ts", "src/keep.ts"), state, "未変更");
  assert.equal(renameFileTreeEntry(state, "docs", "renamed"), state, "未取得のディレクトリ");
  assert.equal(renameFileTreeEntry(state, "docs/note.txt", "docs/renamed.txt"), state, "未取得の親の行");
  assert.deepEqual(renameFileTreeEntry(state, "src/keep.ts", "src/renamed.ts").src.children, [file("renamed.ts")]);
});

test("__proto__ という名前へのリネームも own プロパティとして扱う", () => {
  let state = loaded({ ".": [dir("src")], src: [file("x.ts")] });
  state = toggleFileTreeDirectory(state, "src");
  const renamed = renameFileTreeEntry(state, "src", "__proto__");
  assert.equal(Object.hasOwn(renamed, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(renamed), Object.prototype);
  assert.equal(renamed["__proto__"].open, true);
  assert.deepEqual(renamed["."].children, [dir("__proto__")]);
});

// 取得中にリネームした場合。飛んでいた一覧は旧キーへ着地するため、loading を持ち越すと新しいキーが
// 「読み込み中…」のまま固定される (pendingFileTreeDirectories は loading を拾わない)
test("取得中のリネームは loading を落として新しいキーで取り直す", () => {
  let state = loaded({ ".": [dir("big"), dir("other")] });
  state = beginFileTreeLoad(toggleFileTreeDirectory(state, "big"), "big");
  assert.equal(fileTreeDirectoryState(state, "big")?.loading, true);
  assert.deepEqual(pendingFileTreeDirectories(state), []);

  const renamed = renameFileTreeEntry(state, "big", "renamed");
  assert.equal(fileTreeDirectoryState(renamed, "renamed")?.loading, false, "loading を持ち越している");
  assert.equal(renamed.renamed.open, true, "開いている階層は保つ");
  assert.deepEqual(pendingFileTreeDirectories(renamed), ["renamed"], "新しいキーが再取得の対象になる");

  // 旧キーへ着地した一覧は新しいキーを汚さない (表示は新しい名前の行のまま)
  const landed = applyFileTreeListing(renamed, "big", { entries: [file("inner.txt")], truncated: false });
  assert.equal(fileTreeDirectoryState(landed, "renamed")?.children, undefined, "旧キーの応答で新キーが埋まる");
  assert.equal(fileTreeDirectoryState(landed, "renamed")?.loading, false);
  assert.deepEqual(pendingFileTreeDirectories(landed), ["renamed"], "新キーは pending のまま");

  // 新しいキーで取得が進むと子が入り、pending から外れる
  const refetched = applyFileTreeListing(landed, "renamed", { entries: [file("inner.txt")], truncated: false });
  assert.deepEqual(fileTreeDirectoryState(refetched, "renamed")?.children, [file("inner.txt")]);
  assert.deepEqual(pendingFileTreeDirectories(refetched), []);
});

// 取得中の配下も同じく、張り替え後のキーで取り直せる
test("取得中の配下を持つディレクトリをリネームしても配下の loading を持ち越さない", () => {
  let state = loaded({ ".": [dir("big")], big: [dir("sub")] });
  state = toggleFileTreeDirectory(state, "big");
  state = beginFileTreeLoad(toggleFileTreeDirectory(state, "big/sub"), "big/sub");
  assert.deepEqual(pendingFileTreeDirectories(state), []);

  const renamed = renameFileTreeEntry(state, "big", "renamed");
  assert.equal(fileTreeDirectoryState(renamed, "renamed")?.loading, false);
  assert.equal(fileTreeDirectoryState(renamed, "renamed/sub")?.loading, false, "配下の loading を持ち越している");
  assert.equal(fileTreeDirectoryState(renamed, "renamed/sub")?.open, true);
  assert.deepEqual(pendingFileTreeDirectories(renamed), ["renamed/sub"], "配下が再取得の対象になる");
});

test("祖先ディレクトリは root から近い順に返し、root 直下は空になる", () => {
  assert.deepEqual(fileTreeAncestorPaths("a.txt"), []);
  assert.deepEqual(fileTreeAncestorPaths("a/b/c.txt"), ["a", "a/b"]);
  // ディレクトリ自身の祖先は親まで (自分は含めない)
  assert.deepEqual(fileTreeAncestorPaths("a/b"), ["a"]);
  assert.deepEqual(fileTreeAncestorPaths("."), []);
  // 空セグメントは無視する (画面の root 相対パスは正規化済みだが、字面で崩れても状態キーを汚さない)
  assert.deepEqual(fileTreeAncestorPaths("a//b.txt"), ["a"]);
});

test("reveal は祖先だけを開き、root 直下のファイルでは何もしない", () => {
  // root 直下のファイルは root が元から開いているので、新しい object を作らない
  const topLevel = loaded({ ".": [dir("a"), file("top.txt")] });
  assert.equal(openFileTreeAncestors(topLevel, "top.txt"), topLevel);

  const state = loaded({ ".": [dir("a")], a: [dir("b")] });
  const revealed = openFileTreeAncestors(state, "a/b/c.txt");
  assert.equal(fileTreeDirectoryState(revealed, "a")?.open, true);
  assert.equal(fileTreeDirectoryState(revealed, "a/b")?.open, true, "未取得の祖先も open にして取得対象にする");
  assert.deepEqual(fileTreeDirectoryState(revealed, "a")?.children, [dir("b")], "取得済みの子を落とす");
  assert.deepEqual(pendingFileTreeDirectories(revealed), ["a/b"], "取得が必要なのは未取得の祖先だけ");
});

test("reveal は取得済みの子・loading・error を保ち、開いている祖先では同じ object を返す", () => {
  let state = loaded({ ".": [dir("a")], a: [dir("b")], "a/b": [file("c.txt")] });
  state = toggleFileTreeDirectory(state, "a");
  state = toggleFileTreeDirectory(state, "a/b");

  // すでに必要な祖先がすべて開いているときは新しい object を作らない
  assert.equal(openFileTreeAncestors(state, "a/b/c.txt"), state);

  // 取得中の祖先を開いても loading を落とさない (飛んでいる応答を捨てないため)
  const loading = beginFileTreeLoad(renameFileTreeEntry(state, "a", "renamed"), "renamed");
  const revealed = openFileTreeAncestors(loading, "renamed/sub/deep.txt");
  assert.equal(fileTreeDirectoryState(revealed, "renamed")?.loading, true, "loading を持ち越していない");
  assert.deepEqual(fileTreeDirectoryState(revealed, "renamed")?.children, [dir("b")]);
  assert.equal(fileTreeDirectoryState(revealed, "renamed/sub")?.open, true);
});

test("親を閉じた後でも reveal は対象の祖先を開き直す", () => {
  // 閉じた枝の子孫も閉じて保存されるため、reveal は祖先を改めて開く必要がある
  let state = loaded({
    ".": [dir("a")],
    a: [dir("b")],
    "a/b": [dir("c")],
    "a/b/c": [file("deep.txt")],
  });
  state = toggleFileTreeDirectory(state, "a");
  state = toggleFileTreeDirectory(state, "a/b");
  state = toggleFileTreeDirectory(state, "a/b/c");
  const collapsed = toggleFileTreeDirectory(state, "a");
  assert.equal(fileTreeDirectoryState(collapsed, "a/b/c")?.open, false);

  const revealed = openFileTreeAncestors(collapsed, "a/b/c/deep.txt");
  assert.equal(fileTreeDirectoryState(revealed, "a")?.open, true);
  assert.equal(fileTreeDirectoryState(revealed, "a/b")?.open, true);
  assert.equal(fileTreeDirectoryState(revealed, "a/b/c")?.open, true);
  assert.deepEqual(pendingFileTreeDirectories(revealed), [], "取得済みの子は取り直さない");
});

test("__proto__ の名前の祖先も own プロパティとして開く", () => {
  const revealed = openFileTreeAncestors(createFileTreeState(), "__proto__/x/y.txt");
  assert.equal(Object.getPrototypeOf(revealed), Object.prototype, "プロトタイプを壊す");
  assert.equal(Object.hasOwn(revealed, "__proto__"), true);
  assert.equal(fileTreeDirectoryState(revealed, "__proto__")?.open, true);
  assert.equal(fileTreeDirectoryState(revealed, "__proto__/x")?.open, true);
});

test("パンくずは画面 root 相対の祖先とファイルを並べる", () => {
  assert.deepEqual(fileTreeBreadcrumbs("a/b/c.txt"), [
    { label: "a", path: "a" },
    { label: "b", path: "a/b" },
    { label: "c.txt", path: "a/b/c.txt" },
  ]);
  // 深い階層でも画面 root は出さない (ツリーにその行が無く押せないうえ、パネルのヘッダが同じパスを出す)
  assert.deepEqual(fileTreeBreadcrumbs("client/src/a.ts"), [
    { label: "client", path: "client" },
    { label: "src", path: "client/src" },
    { label: "a.ts", path: "client/src/a.ts" },
  ]);
});

test("パンくずは root 直下のファイルを 1 項目にする", () => {
  assert.deepEqual(fileTreeBreadcrumbs("top.txt"), [{ label: "top.txt", path: "top.txt" }]);
});

test("取得済みの行は親の子から名前で引く (未取得の親と一覧の上限外は undefined)", () => {
  const state = loaded({
    ".": [dir("a"), file("top.txt", { size: 12 })],
    a: [file("sheet.png", { size: 34 }), file("sheet.png.bak", { size: 56 })],
  });
  assert.equal(fileTreeEntryFor(state, "top.txt")?.size, 12, "root 直下も引ける");
  assert.equal(fileTreeEntryFor(state, "a/sheet.png")?.size, 34, "前方一致で別の行を拾わない");
  assert.equal(fileTreeEntryFor(state, "a/missing.png"), undefined, "一覧に無い名前");
  assert.equal(fileTreeEntryFor(state, "b/sheet.png"), undefined, "未取得の親");
});

test("取得を捨てた面 (再読み込み) では行を引かない", () => {
  const state = invalidateFileTree(loaded({ ".": [file("top.txt", { size: 12 })] }));
  assert.equal(fileTreeEntryFor(state, "top.txt"), undefined, "取得済みの子が無いのでサイズも分からない");
});

test("__proto__ の名前のファイルも親の子から引ける", () => {
  let state = applyFileTreeListing(createFileTreeState(), ".", { entries: [dir("__proto__")], truncated: false });
  state = applyFileTreeListing(state, "__proto__", { entries: [file("x.png", { size: 7 })], truncated: false });
  assert.equal(Object.getPrototypeOf(state), Object.prototype, "プロトタイプを壊す");
  assert.equal(fileTreeEntryFor(state, "__proto__/x.png")?.size, 7);
});
