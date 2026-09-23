// ファイルプレビューのタブ。DOM を使わず、開閉と上限・選択の遷移だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  closeFileTab,
  closeFileTabsUnder,
  createFileTabsState,
  dropClosedPreviewModes,
  dropClosedPreviews,
  FILE_TAB_LIMIT,
  fileTabLabels,
  keepsFullscreenPreview,
  openFileTab,
  previewModeFor,
  readPreview,
  renameFileTabs,
  renamePreviewModes,
  restoreFileTabsState,
  withPreviewMode,
} from "../src/lib/fileTabs";

test("開いたタブは末尾に積み、そのタブを表示する", () => {
  let state = createFileTabsState();
  assert.deepEqual(state, { paths: [], active: null });
  state = openFileTab(state, "a.txt");
  state = openFileTab(state, "dir/b.txt");
  assert.deepEqual(state, { paths: ["a.txt", "dir/b.txt"], active: "dir/b.txt" });
});

test("既に開いているタブを選び直しても並びは変えず、表示だけ移す", () => {
  let state = openFileTab(openFileTab(createFileTabsState(), "a.txt"), "b.txt");
  state = openFileTab(state, "a.txt");
  assert.deepEqual(state, { paths: ["a.txt", "b.txt"], active: "a.txt" });
});

test("上限を超えたら最も古いタブを閉じる", () => {
  let state = createFileTabsState();
  for (let i = 0; i < FILE_TAB_LIMIT + 2; i++) state = openFileTab(state, `f${i}.txt`);
  assert.equal(state.paths.length, FILE_TAB_LIMIT);
  assert.deepEqual(state.paths.slice(0, 2), ["f2.txt", "f3.txt"]);
  assert.equal(state.active, `f${FILE_TAB_LIMIT + 1}.txt`);
});

test("上限の判定は既に開いているタブには効かない (増えないので閉じない)", () => {
  let state = createFileTabsState();
  for (let i = 0; i < FILE_TAB_LIMIT; i++) state = openFileTab(state, `f${i}.txt`);
  state = openFileTab(state, "f0.txt");
  assert.equal(state.paths.length, FILE_TAB_LIMIT);
  assert.equal(state.active, "f0.txt");
});

test("表示中のタブを閉じたら右隣、無ければ左隣を表示する", () => {
  const state = openFileTab(openFileTab(openFileTab(createFileTabsState(), "a.txt"), "b.txt"), "c.txt");
  assert.deepEqual(closeFileTab({ ...state, active: "b.txt" }, "b.txt"), {
    paths: ["a.txt", "c.txt"],
    active: "c.txt",
  });
  assert.deepEqual(closeFileTab(state, "c.txt"), { paths: ["a.txt", "b.txt"], active: "b.txt" });
});

test("表示中でないタブを閉じても表示は動かない", () => {
  const state = openFileTab(openFileTab(createFileTabsState(), "a.txt"), "b.txt");
  assert.deepEqual(closeFileTab(state, "a.txt"), { paths: ["b.txt"], active: "b.txt" });
});

test("最後のタブを閉じるとタブが無くなる", () => {
  const state = openFileTab(createFileTabsState(), "a.txt");
  assert.deepEqual(closeFileTab(state, "a.txt"), { paths: [], active: null });
});

test("開いていないタブを閉じても状態は変わらない", () => {
  const state = openFileTab(createFileTabsState(), "a.txt");
  assert.deepEqual(closeFileTab(state, "b.txt"), state);
});

test("ディレクトリ配下のタブをまとめて閉じ、表示は既存の規則で繰り上がる", () => {
  const state = openFileTab(
    openFileTab(openFileTab(openFileTab(createFileTabsState(), "a.txt"), "dir/x.txt"), "dir/y.txt"),
    "b.txt",
  );

  // 表示中が配下でなければ表示は動かない
  assert.deepEqual(closeFileTabsUnder(state, "dir"), { paths: ["a.txt", "b.txt"], active: "b.txt" });

  // 表示中が配下なら右の生存タブへ繰り上がる (closeFileTab と同じ規則)
  assert.deepEqual(closeFileTabsUnder({ ...state, active: "dir/y.txt" }, "dir"), {
    paths: ["a.txt", "b.txt"],
    active: "b.txt",
  });

  // 右に生存タブが無ければ左へ
  const leftOnly = { paths: ["a.txt", "dir/x.txt", "dir/y.txt"], active: "dir/y.txt" };
  assert.deepEqual(closeFileTabsUnder(leftOnly, "dir"), { paths: ["a.txt"], active: "a.txt" });

  // 全部配下ならタブが無くなる
  const allInside = { paths: ["dir/x.txt", "dir/y.txt"], active: "dir/y.txt" };
  assert.deepEqual(closeFileTabsUnder(allInside, "dir"), { paths: [], active: null });

  // 接頭辞境界: dir の削除で dir2 を閉じない
  const sibling = { paths: ["dir2/x.txt", "dir/x.txt"], active: "dir/x.txt" };
  assert.deepEqual(closeFileTabsUnder(sibling, "dir"), { paths: ["dir2/x.txt"], active: "dir2/x.txt" });

  // 対象が無いときは同じ object を返す (再 render を起こさない)
  assert.equal(closeFileTabsUnder(state, "other"), state);
  assert.equal(closeFileTabsUnder(state, "dir/x"), state, "ファイル自身のパスは対象外");
});

test("__proto__ という名前のディレクトリ配下のタブも閉じる", () => {
  const state = { paths: ["__proto__/x.txt", "__proto__/y.txt"], active: "__proto__/y.txt" };
  assert.deepEqual(closeFileTabsUnder(state, "__proto__"), { paths: [], active: null });
});

test("タブのラベルは名前だけで、同名のタブがあるときだけ親ディレクトリを前置する", () => {
  assert.deepEqual(fileTabLabels(["README.md", "src/main.tsx"]), ["README.md", "main.tsx"]);
  assert.deepEqual(fileTabLabels(["package.json", "client/package.json"]), ["package.json", "client/package.json"]);
});

test("同名タブが閉じたらラベルは名前だけに戻る", () => {
  assert.deepEqual(fileTabLabels(["client/index.html", "public/index.html", "client/package.json"]), [
    "client/index.html",
    "public/index.html",
    "package.json",
  ]);
});

test("Object.prototype の名前のパスを保持済みと誤認しない", () => {
  const results = { "a.txt": { text: "a" } };
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(readPreview(results, name), undefined);
  }
  assert.deepEqual(readPreview(results, "a.txt"), { text: "a" });
  // own property として書けば読める (書き込み側の computed key は継承プロパティを上書きしない)
  assert.deepEqual(readPreview({ ...results, ["constructor"]: { text: "c" } }, "constructor"), { text: "c" });
});

test("閉じたタブの本文だけを捨てる", () => {
  const results = { "a.txt": { text: "a" }, "dir/b.txt": { text: "b" } };
  assert.deepEqual(dropClosedPreviews(results, ["a.txt"]), { "a.txt": { text: "a" } });
  // 中身が変わらないときは同じ object を返す (setState の再 render を起こさない)
  assert.equal(dropClosedPreviews(results, ["a.txt", "dir/b.txt"]), results);
});

test("表示モードの既定は HTML と画像だけプレビュー", () => {
  const modes = {};
  assert.equal(previewModeFor(modes, "a.html"), "preview");
  assert.equal(previewModeFor(modes, "dir/b.htm"), "preview");
  // 画像は raw の <img> で描くためプレビューが既定 (ソース表示はバイナリで失敗する)
  assert.equal(previewModeFor(modes, "photo.png"), "preview");
  assert.equal(previewModeFor(modes, "dir/logo.JPEG"), "preview");
  assert.equal(previewModeFor(modes, "icon.ico"), "preview");
  assert.equal(previewModeFor(modes, "a.svg"), "source");
  assert.equal(previewModeFor(modes, "a.ts"), "source");
  assert.equal(previewModeFor(modes, "a.xhtml"), "source");
  // 選び直したタブは選択を優先する
  const chosen = withPreviewMode(withPreviewMode(modes, "a.html", "source"), "a.ts", "preview");
  assert.equal(previewModeFor(chosen, "a.html"), "source");
  assert.equal(previewModeFor(chosen, "a.ts"), "preview");
});

test("表示モードの選択も Object.prototype の名前のパスで壊れない", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    // 未選択として既定 (拡張子の無いパスはソース) を返す
    assert.equal(previewModeFor({}, name), "source");
    const modes = withPreviewMode({}, name, "preview");
    assert.equal(Object.hasOwn(modes, name), true, name);
    assert.equal(Object.getPrototypeOf(modes), Object.prototype, name);
    assert.deepEqual(previewModeFor(modes, name), "preview");
  }
});

test("閉じたタブの表示モードだけを捨てる", () => {
  const modes = { "a.html": "source", "dir/b.html": "source" } as const;
  assert.deepEqual(dropClosedPreviewModes(modes, ["a.html"]), { "a.html": "source" });
  // 中身が変わらないときは同じ object を返す (setState の再 render を起こさない)
  assert.equal(dropClosedPreviewModes(modes, ["a.html", "dir/b.html"]), modes);
});

// 全画面を続ける条件。全画面を出したタブ (第 1 引数) をそのまま表示している間だけ true になる
test("全画面を続けるのは 全画面を出したタブの HTML プレビューだけ", () => {
  assert.equal(keepsFullscreenPreview("a.html", "a.html", "preview"), true);
  assert.equal(keepsFullscreenPreview("dir/b.htm", "dir/b.htm", "preview"), true);
  // 他のタブへ切り替えると解除する (HTML 同士でも続けない)
  assert.equal(keepsFullscreenPreview("a.html", "b.html", "preview"), false);
  assert.equal(keepsFullscreenPreview("a.html", "dir/b.html", "preview"), false);
  // 全画面のタブを閉じて次が繰り上がったときも、表示対象が変わるので解除する
  assert.equal(keepsFullscreenPreview("a.html", "b.html", "source"), false, "繰り上がった先がソース表示");
  // ソース表示へ切り替えると続けない
  assert.equal(keepsFullscreenPreview("a.html", "a.html", "source"), false);
  // HTML 以外 (他拡張子のタブ・拡張子の無いパス) はプレビューでも続けない
  assert.equal(keepsFullscreenPreview("a.ts", "a.ts", "preview"), false);
  assert.equal(keepsFullscreenPreview("a.xhtml", "a.xhtml", "preview"), false);
  // 全画面でない (null) ときは常に false
  assert.equal(keepsFullscreenPreview(null, "a.html", "preview"), false);
});

// 保存値からの復元。復元後は通常のタブ操作 (開閉・上限) にそのまま乗る
test("保存値の表示中が無いときは末尾 (最後に開いたタブ) を選ぶ", () => {
  assert.deepEqual(restoreFileTabsState([], null), { paths: [], active: null });
  assert.deepEqual(restoreFileTabsState([], "a.txt"), { paths: [], active: null }, "タブが無ければ表示中も無い");
  assert.deepEqual(restoreFileTabsState(["a.txt", "b.txt"], "a.txt"), { paths: ["a.txt", "b.txt"], active: "a.txt" });
  assert.deepEqual(restoreFileTabsState(["a.txt", "b.txt"], null), { paths: ["a.txt", "b.txt"], active: "b.txt" });
  assert.deepEqual(
    restoreFileTabsState(["a.txt", "b.txt"], "nope.txt"),
    { paths: ["a.txt", "b.txt"], active: "b.txt" },
    "paths に無い表示中は末尾へ倒す",
  );
});

test("復元したタブでも表示中の切替と上限は同じ契約", () => {
  let state = restoreFileTabsState(["a.txt", "b.txt"], "a.txt");
  state = openFileTab(state, "a.txt");
  assert.deepEqual(state, { paths: ["a.txt", "b.txt"], active: "a.txt" }, "選び直しでは並びを変えない");
  state = restoreFileTabsState(
    Array.from({ length: FILE_TAB_LIMIT }, (_, i) => `${i}.txt`),
    `${FILE_TAB_LIMIT - 1}.txt`,
  );
  state = openFileTab(state, "new.txt");
  assert.equal(state.paths.length, FILE_TAB_LIMIT, "上限を超えない");
  assert.deepEqual(state.paths[0], "1.txt", "最も古いタブから落ちる");
});

// リネーム後の経路の張り替え。並びと表示中のタブを保ち、配下のタブも一緒に移す
test("リネームはタブの経路を張り替え、並びと表示中のタブを保つ", () => {
  const state = openFileTab(
    openFileTab(openFileTab(openFileTab(createFileTabsState(), "a.txt"), "dir/x.txt"), "dir/deep/y.txt"),
    "b.txt",
  );
  assert.deepEqual(renameFileTabs(state, "dir", "renamed"), {
    paths: ["a.txt", "renamed/x.txt", "renamed/deep/y.txt", "b.txt"],
    active: "b.txt",
  });
  // 表示中のタブが配下なら表示も移る
  assert.deepEqual(renameFileTabs({ ...state, active: "dir/deep/y.txt" }, "dir", "renamed"), {
    paths: ["a.txt", "renamed/x.txt", "renamed/deep/y.txt", "b.txt"],
    active: "renamed/deep/y.txt",
  });
  // ファイル自身のリネームはそのタブだけ
  assert.deepEqual(renameFileTabs(state, "a.txt", "renamed.txt"), {
    paths: ["renamed.txt", "dir/x.txt", "dir/deep/y.txt", "b.txt"],
    active: "b.txt",
  });
  // 接頭辞境界: dir の改名で dir2 を巻き込まない
  const sibling = { paths: ["dir2/x.txt", "dir/x.txt"], active: "dir/x.txt" };
  assert.deepEqual(renameFileTabs(sibling, "dir", "renamed"), {
    paths: ["dir2/x.txt", "renamed/x.txt"],
    active: "renamed/x.txt",
  });
  // 対象が無いときは同じ object を返す (再 render を起こさない)
  assert.equal(renameFileTabs(state, "other", "renamed"), state);
  assert.equal(renameFileTabs(state, "dir/x.txt", "dir/x.txt"), state, "未変更");
});

test("リネーム先が既存のタブと同じ経路になったら重複させない", () => {
  // 消えていたファイルのタブが残っている状態で、その名前へリネームした場合
  const state = { paths: ["dir/old.txt", "dir/note.txt"], active: "dir/note.txt" };
  assert.deepEqual(renameFileTabs(state, "dir/note.txt", "dir/old.txt"), {
    paths: ["dir/old.txt"],
    active: "dir/old.txt",
  });
});

test("リネームは表示モードの経路も張り替える", () => {
  const modes = withPreviewMode(withPreviewMode({}, "dir/a.html", "source"), "dir/b.html", "preview");
  assert.deepEqual(renamePreviewModes(modes, "dir", "renamed"), {
    "renamed/a.html": "source",
    "renamed/b.html": "preview",
  });
  assert.deepEqual(renamePreviewModes(modes, "dir/a.html", "dir/c.html"), {
    "dir/c.html": "source",
    "dir/b.html": "preview",
  });
  // 対象が無いときは同じ object を返す
  assert.equal(renamePreviewModes(modes, "other", "renamed"), modes);
  assert.equal(renamePreviewModes(modes, "dir/a.html", "dir/a.html"), modes, "未変更");
});
