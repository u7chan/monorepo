import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileTreeHeightResizeHandle } from "../src/components/file-tree/FileTreeHeightResizeHandle";
import {
  canResizeFileTreeHeight,
  clampFileTreeHeight,
  createFileTreeHeightStore,
  fileTreeHeight,
  fileTreeHeightBounds,
  fileTreeHeightLimit,
  parseFileTreeHeight,
  stepFileTreeHeight,
  FILE_TREE_HEIGHT_DEFAULT_MAX,
  FILE_TREE_HEIGHT_KEY,
  FILE_TREE_HEIGHT_MIN,
  FILE_TREE_HEIGHT_STEP,
  FILE_TREE_HEIGHT_STORE_LIMIT,
  FILE_TREE_PREVIEW_MIN_HEIGHT,
  type FileTreeHeightBounds,
  type FileTreeHeightStorage,
} from "../src/lib/fileTreeHeight";

test("bounds は容器の高さから上限を引き、未計測 (0 以下) は null にする", () => {
  assert.equal(FILE_TREE_HEIGHT_MIN, 0);
  assert.equal(FILE_TREE_HEIGHT_DEFAULT_MAX, 256);
  assert.equal(FILE_TREE_PREVIEW_MIN_HEIGHT, 240);
  assert.equal(FILE_TREE_HEIGHT_STEP, 16);
  assert.equal(FILE_TREE_HEIGHT_STORE_LIMIT, 2000);
  assert.equal(FILE_TREE_HEIGHT_KEY, "u7agent-file-tree-height");
  // 未計測 (mount 直後 / display: none の保持中) は高さを推測しない
  assert.equal(fileTreeHeightBounds(0), null);
  assert.equal(fileTreeHeightBounds(-1), null);
  assert.equal(fileTreeHeightBounds(0.4), null);
  // 下限は 0 (ツリーを完全に隠せる)。上限 = 容器 − プレビュー下限
  assert.deepEqual(fileTreeHeightBounds(240), { min: 0, max: 0 });
  assert.deepEqual(fileTreeHeightBounds(241), { min: 0, max: 1 });
  assert.deepEqual(fileTreeHeightBounds(776), { min: 0, max: 536 });
  assert.deepEqual(fileTreeHeightBounds(400), { min: 0, max: 160 });
});

test("プレビューの下限以下では高さを選べない (ハンドルを出さない)", () => {
  assert.equal(canResizeFileTreeHeight(null), false);
  assert.equal(canResizeFileTreeHeight(fileTreeHeightBounds(240)), false);
  assert.equal(canResizeFileTreeHeight(fileTreeHeightBounds(200)), false);
  assert.equal(canResizeFileTreeHeight(fileTreeHeightBounds(241)), true);
  assert.equal(canResizeFileTreeHeight(fileTreeHeightBounds(900)), true);
});

test("表示高さは未指定 (auto) を null のまま返し、計測後は保存値を clamp する", () => {
  // 未指定は CSS へ px を渡さない (内容の高さ + 上限に任せる)
  assert.equal(fileTreeHeight(null, 0), null);
  assert.equal(fileTreeHeight(null, 776), null);
  // 未計測: 上限が決まらないため選択値をそのまま使う (計測後に clamp する)
  assert.equal(fileTreeHeight(400, 0), 400);
  assert.equal(fileTreeHeight(0, 0), 0);
  // 計測後: 上限は容器 − プレビュー下限。0 はそのまま (ツリーを完全に隠す)
  assert.equal(fileTreeHeight(300, 776), 300);
  assert.equal(fileTreeHeight(600, 776), 536);
  assert.equal(fileTreeHeight(0, 776), 0);
  assert.equal(fileTreeHeight(300, 400), 160);
  // 端数は丸める (保存値 / aria-valuenow と揃える)
  const bounds = fileTreeHeightBounds(776) as FileTreeHeightBounds;
  assert.equal(clampFileTreeHeight(300.6, bounds), 301);
});

test("CSS 変数へ入れる上限は、既定の上限 (256px) と容器から決まる上限の小さい方", () => {
  // 未指定のときの上限。従来の max-h-64 (256px) を、容器が低いときはプレビュー下限で頭打ちにする
  assert.equal(fileTreeHeightLimit(776), 256);
  assert.equal(fileTreeHeightLimit(400), 160);
  assert.equal(fileTreeHeightLimit(240), 0);
  // 未計測は推測せず既定の上限 (計測後に容器ぶんまで詰める)
  assert.equal(fileTreeHeightLimit(0), 256);
});

test("キーボードの 1 歩は 16px で、端では止まる", () => {
  const bounds = fileTreeHeightBounds(776) as FileTreeHeightBounds;
  assert.equal(stepFileTreeHeight(256, FILE_TREE_HEIGHT_STEP, bounds), 272);
  assert.equal(stepFileTreeHeight(256, -FILE_TREE_HEIGHT_STEP, bounds), 240);
  assert.equal(stepFileTreeHeight(bounds.max, FILE_TREE_HEIGHT_STEP, bounds), bounds.max);
  // 下限は 0 = ツリーを完全に隠す
  assert.equal(stepFileTreeHeight(8, -FILE_TREE_HEIGHT_STEP, bounds), 0);
});

test("256px 以下へ縮めても、ツリー以外の高さはプレビューへ残る", () => {
  for (const container of [241, 300, 400, 776, 1200, 2000]) {
    const bounds = fileTreeHeightBounds(container) as FileTreeHeightBounds;
    assert.ok(
      container - bounds.max >= FILE_TREE_PREVIEW_MIN_HEIGHT,
      `容器 ${container}px でプレビューが ${container - bounds.max}px になる`,
    );
  }
});

test("保存値は 0 (完全に隠した状態) を採り、壊れていれば未設定として捨てる", () => {
  assert.equal(parseFileTreeHeight("0"), 0);
  assert.equal(parseFileTreeHeight("300"), 300);
  assert.equal(parseFileTreeHeight(String(FILE_TREE_HEIGHT_STORE_LIMIT)), 2000);
  // 負 / 端数 / 極端な値 / 数値でない値 / 前後の空白
  assert.equal(parseFileTreeHeight("-5"), null);
  assert.equal(parseFileTreeHeight("300.5"), null);
  assert.equal(parseFileTreeHeight(String(FILE_TREE_HEIGHT_STORE_LIMIT + 1)), null);
  assert.equal(parseFileTreeHeight("tall"), null);
  assert.equal(parseFileTreeHeight(" 300"), null);
  assert.equal(parseFileTreeHeight(""), null);
  assert.equal(parseFileTreeHeight(null), null);
});

class MemoryStorage implements FileTreeHeightStorage {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, next: string): void {
    this.value = next;
  }
  removeItem(): void {
    this.value = null;
  }
}

test("store は 1 キーを読み書きし、未指定へ戻すとキーを消す", () => {
  const storage = new MemoryStorage();
  const store = createFileTreeHeightStore(storage);
  assert.equal(store.read(), null);
  store.write(300);
  assert.equal(storage.value, "300");
  assert.equal(store.read(), 300);
  // 0 も選んだ値として保つ
  store.write(0);
  assert.equal(storage.value, "0");
  assert.equal(store.read(), 0);
  // 壊れた保存値は未設定へ落ちる
  storage.value = "300.5";
  assert.equal(createFileTreeHeightStore(storage).read(), null);
  store.write(null);
  assert.equal(storage.value, null);
  assert.equal(store.read(), null);
});

test("保存領域が使えない環境でも操作を止めない (session 内のメモリで保つ)", () => {
  const throwing: FileTreeHeightStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  const store = createFileTreeHeightStore(throwing);
  assert.equal(store.read(), null);
  store.write(300);
  assert.equal(store.read(), 300);
  store.write(null);
  assert.equal(store.read(), null);
  // storage が無い (window が無い) ときも同じ
  const none = createFileTreeHeightStore(null);
  none.write(0);
  assert.equal(none.read(), 0);
});

test("ハンドルは読み上げ用の属性を持つ (上下の境界だと分かる向き)", () => {
  const html = renderToStaticMarkup(
    createElement(FileTreeHeightResizeHandle, {
      height: 300,
      min: 0,
      max: 536,
      preview: () => {},
      commit: () => {},
      reset: () => {},
    }),
  );
  assert.ok(html.includes('role="separator"'));
  assert.ok(html.includes('aria-label="ファイルツリーの高さ"'));
  assert.ok(html.includes('aria-orientation="horizontal"'));
  assert.ok(html.includes('aria-valuemin="0"'));
  assert.ok(html.includes('aria-valuemax="536"'));
  assert.ok(html.includes('aria-valuenow="300"'));
  assert.ok(html.includes('tabindex="0"'));
});
