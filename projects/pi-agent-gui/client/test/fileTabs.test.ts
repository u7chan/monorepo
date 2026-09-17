// ファイルプレビューのタブ。DOM を使わず、開閉と上限・選択の遷移だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  closeFileTab,
  createFileTabsState,
  dropClosedPreviews,
  FILE_TAB_LIMIT,
  fileTabLabels,
  openFileTab,
  readPreview,
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
