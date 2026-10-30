// ファイルツリーのアイコンの見た目。保存値の解決と store の読み書き (localStorage / メモリ) を固定する。
import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileIcon, FolderIcon } from "../src/components/icons";
import {
  createFileIconStyleStore,
  DEFAULT_FILE_ICON_STYLE,
  FILE_ICON_STYLE_KEY,
  FILE_ICON_STYLES,
  fileIconStyleStore,
  isFileIconStyle,
  parseFileIconStyle,
  type FileIconStyleStorage,
} from "../src/lib/fileIconStyle";

class MemoryStorage implements FileIconStyleStorage {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, next: string): void {
    this.value = next;
  }
}

test("選べる見た目は 3 つで、既定は先頭の線", () => {
  assert.deepEqual(
    FILE_ICON_STYLES.map((style) => style.id),
    ["line", "tint", "fill"],
  );
  assert.equal(DEFAULT_FILE_ICON_STYLE, FILE_ICON_STYLES[0].id);
  assert.equal(FILE_ICON_STYLE_KEY, "u7agent-file-icons");
  // 保存値は端末ローカルの表示設定。サーバーへ送る値ではない
  assert.ok(FILE_ICON_STYLES.every((style) => style.label.length > 0 && style.description.length > 0));
});

test("保存値の解決は既知の値だけを採り、未保存と未知の値は既定へ倒す", () => {
  for (const style of FILE_ICON_STYLES) {
    assert.equal(parseFileIconStyle(style.id), style.id);
    assert.equal(isFileIconStyle(style.id), true);
  }
  for (const raw of [null, "", "LINE", "solid", "line ", "fill\n"]) {
    assert.equal(parseFileIconStyle(raw), DEFAULT_FILE_ICON_STYLE);
    assert.equal(isFileIconStyle(raw), false);
  }
  // store 経由で読んでも同じ解決になる
  const storage = new MemoryStorage();
  storage.value = "unknown";
  assert.equal(createFileIconStyleStore(storage).read(), DEFAULT_FILE_ICON_STYLE);
});

test("store は 1 キーを読み書きし、未知の値は既定として読む", () => {
  const storage = new MemoryStorage();
  const store = createFileIconStyleStore(storage);
  assert.equal(store.read(), DEFAULT_FILE_ICON_STYLE);
  store.write("tint");
  assert.equal(storage.value, "tint");
  assert.equal(createFileIconStyleStore(storage).read(), "tint");
  store.write("fill");
  assert.equal(storage.value, "fill");
  assert.equal(store.read(), "fill");
});

test("保存領域が使えない環境でも操作を止めない (session 内のメモリで保つ)", () => {
  const throwing: FileIconStyleStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  const store = createFileIconStyleStore(throwing);
  assert.equal(store.read(), DEFAULT_FILE_ICON_STYLE);
  store.write("fill");
  assert.equal(store.read(), "fill");
  // storage が無い (window が無い) ときも同じ
  const none = createFileIconStyleStore(null);
  none.write("tint");
  assert.equal(none.read(), "tint");
});

test("書き込みは同じ画面の読み手へ通知し、解除すると届かない", () => {
  const store = createFileIconStyleStore(new MemoryStorage());
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  store.write("tint");
  store.write("tint");
  assert.equal(calls, 2);
  unsubscribe();
  store.write("fill");
  assert.equal(calls, 2);
  // アプリが使う store も同じ通知を持つ (useSyncExternalStore の購読先)
  let notified = 0;
  const stop = fileIconStyleStore.subscribe(() => {
    notified += 1;
  });
  stop();
  assert.equal(notified, 0);
});

test("アイコンは色の切り替えに使うクラスと種類色の変数を持つ", () => {
  // CSS (styles/index.css) は class と --file-kind を目印に色を差し替えるため、名前を変えると無言で効かなくなる
  const file = renderToStaticMarkup(createElement(FileIcon, { kind: "image" }));
  assert.ok(file.includes('class="file-icon size-4 shrink-0"'));
  assert.ok(file.includes('class="icon-doc"'));
  assert.ok(file.includes('class="icon-mark"'));
  assert.ok(file.includes("--file-kind:var(--c-file-image)"));
  // 種類を持たない呼び出し (設定ナビ) は text の色を持つ
  const text = renderToStaticMarkup(createElement(FileIcon));
  assert.ok(text.includes("--file-kind:var(--c-file-text)"));

  const folder = renderToStaticMarkup(createElement(FolderIcon, { open: true }));
  assert.ok(folder.includes('class="file-folder size-4 shrink-0"'));
  assert.ok(folder.includes('class="icon-doc"'));
  assert.ok(folder.includes('class="icon-front"'));
});
