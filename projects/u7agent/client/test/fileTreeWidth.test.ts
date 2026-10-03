import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FileTreeResizeHandle } from "../src/components/file-tree/FileTreeResizeHandle";
import {
  canResizeFileTree,
  clampFileTreeWidth,
  createFileTreeWidthStore,
  fileTreeWidth,
  fileTreeWidthBounds,
  fileTreeWidthDefault,
  parseFileTreeWidth,
  stepFileTreeWidth,
  FILE_TREE_PREVIEW_MIN_WIDTH,
  FILE_TREE_WIDTH_DEFAULT_DIVISOR,
  FILE_TREE_WIDTH_DEFAULT_MAX,
  FILE_TREE_WIDTH_KEY,
  FILE_TREE_WIDTH_MAX,
  FILE_TREE_WIDTH_MIN,
  FILE_TREE_WIDTH_STEP,
  FILE_TREE_WIDTH_STORE_LIMIT,
  type FileTreeWidthBounds,
  type FileTreeWidthStorage,
} from "../src/lib/fileTreeWidth";

/** 左右 2 段と上下 2 段を分けるコンテナ幅 (Tailwind の `@2xl` = 42rem) */
const LAYOUT_BREAKPOINT = 672;

test("bounds はコンテナ幅から上限を引き、未計測 (0 以下) は null にする", () => {
  assert.equal(FILE_TREE_WIDTH_MIN, 288);
  assert.equal(FILE_TREE_WIDTH_DEFAULT_MAX, 400);
  assert.equal(FILE_TREE_WIDTH_DEFAULT_DIVISOR, 3);
  assert.equal(FILE_TREE_WIDTH_MAX, 560);
  assert.equal(FILE_TREE_PREVIEW_MIN_WIDTH, 384);
  assert.equal(FILE_TREE_WIDTH_STEP, 16);
  assert.equal(FILE_TREE_WIDTH_STORE_LIMIT, 2000);
  assert.equal(FILE_TREE_WIDTH_KEY, "u7agent-file-tree-width");
  // 未計測 (mount 直後 / display: none の保持中) は幅を推測しない
  assert.equal(fileTreeWidthBounds(0), null);
  assert.equal(fileTreeWidthBounds(-1), null);
  assert.equal(fileTreeWidthBounds(0.4), null);
  // 上限 = min(560, コンテナ − 384)。560 で頭打ちになるのは 944px 以上
  assert.deepEqual(fileTreeWidthBounds(672), { min: 288, max: 288 });
  assert.deepEqual(fileTreeWidthBounds(673), { min: 288, max: 289 });
  assert.deepEqual(fileTreeWidthBounds(880), { min: 288, max: 496 });
  assert.deepEqual(fileTreeWidthBounds(944), { min: 288, max: 560 });
  assert.deepEqual(fileTreeWidthBounds(1920), { min: 288, max: 560 });
});

test("幅を選べるのは 673px 以上だけ (672px 以下は上下 2 段 / @2xl の境界ちょうど)", () => {
  assert.equal(canResizeFileTree(null), false);
  assert.equal(canResizeFileTree(fileTreeWidthBounds(671)), false);
  assert.equal(canResizeFileTree(fileTreeWidthBounds(672)), false);
  assert.equal(canResizeFileTree(fileTreeWidthBounds(673)), true);
  assert.equal(canResizeFileTree(fileTreeWidthBounds(1188)), true);
});

test("既定幅は clamp(288px, コンテナ ÷ 3, 400px)", () => {
  // 1440x900 (左バー 252) の main 1188 → 396。左バー 400 の main 1040 → 347
  assert.equal(fileTreeWidthDefault(1188), 396);
  assert.equal(fileTreeWidthDefault(1040), 347);
  assert.equal(fileTreeWidthDefault(900), 300);
  // 1/3 が下限を割る幅では 288 のまま (今の見た目を悪化させない)
  assert.equal(fileTreeWidthDefault(760), 288);
  assert.equal(fileTreeWidthDefault(720), 288);
  assert.equal(fileTreeWidthDefault(0), 288);
  // 1/3 が 400 を超えたら 400
  assert.equal(fileTreeWidthDefault(4000), 400);
  // 端数は丸める (保存値 / aria-valuenow と揃える)
  assert.equal(fileTreeWidthDefault(1000), 333);
});

test("表示幅は未計測でも常に px を返し、計測後は保存値を clamp する", () => {
  // 未計測: 未指定は下限、保存値はそのまま (var() へ未定義を渡さない)
  assert.equal(fileTreeWidth(null, 0), 288);
  assert.equal(fileTreeWidth(560, 0), 560);
  // 計測後: 未指定は既定 (コンテナ ÷ 3)
  assert.equal(fileTreeWidth(null, 1188), 396);
  assert.equal(fileTreeWidth(null, 760), 288);
  // 保存値は bounds へ clamp する (1440 で 560 → 900 で 516 → 1440 で 560 へ戻る)
  const wide = fileTreeWidthBounds(1188) as FileTreeWidthBounds;
  assert.equal(fileTreeWidth(560, 1188), 560);
  assert.equal(fileTreeWidth(560, 900), 516);
  assert.equal(fileTreeWidth(560, 1188), 560);
  // 端数は丸める
  assert.equal(clampFileTreeWidth(300.6, wide), 301);
});

test("キーボードの 1 歩は 16px で、端では止まる", () => {
  const bounds = fileTreeWidthBounds(1188) as FileTreeWidthBounds;
  assert.equal(stepFileTreeWidth(396, FILE_TREE_WIDTH_STEP, bounds), 412);
  assert.equal(stepFileTreeWidth(396, -FILE_TREE_WIDTH_STEP, bounds), 380);
  assert.equal(stepFileTreeWidth(bounds.max, FILE_TREE_WIDTH_STEP, bounds), bounds.max);
  assert.equal(stepFileTreeWidth(bounds.min, -FILE_TREE_WIDTH_STEP, bounds), bounds.min);
});

test("672px 以上では常にプレビューへ 384px 以上残る", () => {
  for (const container of [672, 673, 720, 760, 900, 944, 1000, 1188, 1440, 1920, 4000]) {
    const bounds = fileTreeWidthBounds(container) as FileTreeWidthBounds;
    assert.ok(
      container - bounds.max >= FILE_TREE_PREVIEW_MIN_WIDTH,
      `コンテナ ${container}px でプレビューが ${container - bounds.max}px になる`,
    );
  }
});

test("規則の整合: 下限 + プレビュー下限 = @2xl の境界 / 既定の上限は選べる範囲の中", () => {
  assert.equal(FILE_TREE_WIDTH_MIN + FILE_TREE_PREVIEW_MIN_WIDTH, LAYOUT_BREAKPOINT);
  assert.ok(FILE_TREE_WIDTH_MIN < FILE_TREE_WIDTH_DEFAULT_MAX, "既定の上限が下限以下");
  assert.ok(FILE_TREE_WIDTH_DEFAULT_MAX < FILE_TREE_WIDTH_MAX, "既定の上限が選べる上限以上");
});

test("保存値は整数だけを採り、壊れていれば未設定として捨てる", () => {
  assert.equal(parseFileTreeWidth("396"), 396);
  assert.equal(parseFileTreeWidth(String(FILE_TREE_WIDTH_STORE_LIMIT)), 2000);
  // 0 以下 / 端数 / 極端な値 / 数値でない値 / 前後の空白
  assert.equal(parseFileTreeWidth("0"), null);
  assert.equal(parseFileTreeWidth("-5"), null);
  assert.equal(parseFileTreeWidth("396.5"), null);
  assert.equal(parseFileTreeWidth(String(FILE_TREE_WIDTH_STORE_LIMIT + 1)), null);
  assert.equal(parseFileTreeWidth("wide"), null);
  assert.equal(parseFileTreeWidth(" 396"), null);
  assert.equal(parseFileTreeWidth(""), null);
  assert.equal(parseFileTreeWidth(null), null);
});

class MemoryStorage implements FileTreeWidthStorage {
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
  const store = createFileTreeWidthStore(storage);
  assert.equal(store.read(), null);
  store.write(560);
  assert.equal(storage.value, "560");
  assert.equal(store.read(), 560);
  // 壊れた保存値は未設定へ落ちる
  storage.value = "560.5";
  assert.equal(createFileTreeWidthStore(storage).read(), null);
  store.write(null);
  assert.equal(storage.value, null);
  assert.equal(store.read(), null);
});

test("保存領域が使えない環境でも操作を止めない (session 内のメモリで保つ)", () => {
  const throwing: FileTreeWidthStorage = {
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
  const store = createFileTreeWidthStore(throwing);
  assert.equal(store.read(), null);
  store.write(560);
  assert.equal(store.read(), 560);
  store.write(null);
  assert.equal(store.read(), null);
  // storage が無い (window が無い) ときも同じ
  const none = createFileTreeWidthStore(null);
  none.write(560);
  assert.equal(none.read(), 560);
});

test("ハンドルは読み上げ用の属性と境界の中央の位置を持つ", () => {
  const html = renderToStaticMarkup(
    createElement(FileTreeResizeHandle, {
      width: 396,
      min: 288,
      max: 560,
      preview: () => {},
      commit: () => {},
      reset: () => {},
    }),
  );
  assert.ok(html.includes('role="separator"'));
  assert.ok(html.includes('aria-label="ファイルツリーの幅"'));
  assert.ok(html.includes('aria-orientation="vertical"'));
  assert.ok(html.includes('aria-valuemin="288"'));
  assert.ok(html.includes('aria-valuemax="560"'));
  assert.ok(html.includes('aria-valuenow="396"'));
  assert.ok(html.includes('tabindex="0"'));
  // 位置は --file-tree-width に追随する (8px のハンドルの中心を境界へ重ねる)
  assert.ok(html.includes("left-[calc(var(--file-tree-width)_-_4px)]"));
});
