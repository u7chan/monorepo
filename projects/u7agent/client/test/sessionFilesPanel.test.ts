import assert from "node:assert/strict";

import test from "node:test";
import {
  canResizeSessionFilesPanel,
  clampSessionFilesPanelWidth,
  createSessionFilesPanelWidthStore,
  parseSessionFilesPanelWidth,
  sessionFilesPanelBounds,
  sessionFilesPanelWidth,
  stepSessionFilesPanelWidth,
  SESSION_FILES_WIDTH_KEY,
  SESSION_FILES_WIDTH_STEP,
  SESSION_FILES_WIDTH_STORE_LIMIT,
  type SessionFilesPanelWidthStorage,
} from "../src/lib/sessionFilesPanel";

/** desktop で左バー (既定幅 252px) が docked のときの main 列の幅 */
function dockedMainWidth(viewportWidth: number): number {
  return viewportWidth - 252;
}

/** 従来幅 (min(360px, 30vw)) を下限、main の残り 320px を上限にした期待値 */
const BOUNDS_BY_VIEWPORT: Record<string, { min: number; max: number }> = {
  "1920": { min: 360, max: 671 },
  "1280": { min: 360, max: 671 },
  "1118": { min: 335, max: 546 },
  "1024": { min: 307, max: 452 },
  "900": { min: 270, max: 328 },
  "820": { min: 246, max: 248 },
  // 下限が上限を追い越すときは下限を優先する (チャットよりパネルの最小幅を守る)
  "720": { min: 216, max: 216 },
};

test("bounds は従来幅 (min(360px, 30vw)) を下限に、main の残り 320px を上限にする", () => {
  for (const [viewportWidth, expected] of Object.entries(BOUNDS_BY_VIEWPORT)) {
    const width = Number(viewportWidth);
    assert.deepEqual(sessionFilesPanelBounds(width, dockedMainWidth(width)), expected, `${viewportWidth}px`);
  }
});

test("bounds は mainWidth だけで変わる (左バーを overlay にすると上限が 252px 増える)", () => {
  const docked = sessionFilesPanelBounds(1118, dockedMainWidth(1118));
  const overlay = sessionFilesPanelBounds(1118, 1118);
  assert.equal(docked.max, 546);
  assert.equal(overlay.max, 671);
  // 下限は viewport だけで決まる (パネルの最小幅は左バーの配置に依存しない)
  assert.equal(docked.min, overlay.min);
});

test("左バーを広げると main が狭くなり、右パネルの上限も下がる", () => {
  // 1200px: 既定 252px なら main 948 → 上限 628、左バーの上限 400px なら main 800 → 上限 480
  assert.equal(sessionFilesPanelBounds(1200, 1200 - 252).max, 628);
  assert.equal(sessionFilesPanelBounds(1200, 1200 - 400).max, 480);
  // 広い窓では右パネル自身の上限 (671px) が効く
  assert.equal(sessionFilesPanelBounds(1920, 1920 - 400).max, 671);
});

test("min == max の幅ではハンドルを出さない", () => {
  assert.equal(canResizeSessionFilesPanel(sessionFilesPanelBounds(720, 468)), false);
  assert.equal(canResizeSessionFilesPanel(sessionFilesPanelBounds(820, 568)), true);
  // 境界は 0.3w = w - 572。817px 以下は下限が上限に届く
  assert.equal(canResizeSessionFilesPanel(sessionFilesPanelBounds(817, 565)), false);
  assert.equal(canResizeSessionFilesPanel(sessionFilesPanelBounds(818, 566)), true);
});

test("表示幅は clamp 済みで、未指定 (null) は最小幅 = 従来幅になる", () => {
  const bounds = sessionFilesPanelBounds(1118, dockedMainWidth(1118));
  assert.equal(sessionFilesPanelWidth(null, bounds), 335);
  assert.equal(sessionFilesPanelWidth(500, bounds), 500);
  assert.equal(sessionFilesPanelWidth(4000, bounds), 546);
  assert.equal(sessionFilesPanelWidth(10, bounds), 335);
  // 端数は丸める (保存値 / aria-valuenow と揃える)
  assert.equal(clampSessionFilesPanelWidth(500.6, bounds), 501);
});

test("キーボードの 1 歩は 16px で、端では止まる", () => {
  const bounds = sessionFilesPanelBounds(1118, dockedMainWidth(1118));
  assert.equal(SESSION_FILES_WIDTH_STEP, 16);
  assert.equal(stepSessionFilesPanelWidth(500, SESSION_FILES_WIDTH_STEP, bounds), 516);
  assert.equal(stepSessionFilesPanelWidth(500, -SESSION_FILES_WIDTH_STEP, bounds), 484);
  assert.equal(stepSessionFilesPanelWidth(bounds.max, SESSION_FILES_WIDTH_STEP, bounds), bounds.max);
  assert.equal(stepSessionFilesPanelWidth(bounds.min, -SESSION_FILES_WIDTH_STEP, bounds), bounds.min);
});

test("保存値は整数だけを採り、壊れていれば未設定として捨てる", () => {
  assert.equal(SESSION_FILES_WIDTH_KEY, "u7agent-session-files-width");
  assert.equal(parseSessionFilesPanelWidth("500"), 500);
  assert.equal(parseSessionFilesPanelWidth(String(SESSION_FILES_WIDTH_STORE_LIMIT)), 2000);
  // 0 以下 / 端数 / 極端な値 / 数値でない値 / 前後の空白
  assert.equal(parseSessionFilesPanelWidth("0"), null);
  assert.equal(parseSessionFilesPanelWidth("-5"), null);
  assert.equal(parseSessionFilesPanelWidth("500.5"), null);
  assert.equal(parseSessionFilesPanelWidth(String(SESSION_FILES_WIDTH_STORE_LIMIT + 1)), null);
  assert.equal(parseSessionFilesPanelWidth("wide"), null);
  assert.equal(parseSessionFilesPanelWidth(" 500"), null);
  assert.equal(parseSessionFilesPanelWidth(""), null);
  assert.equal(parseSessionFilesPanelWidth(null), null);
});

test("保存値が今の bounds の外でも捨てない (表示側で clamp するだけ)", () => {
  const stored = parseSessionFilesPanelWidth("1500");
  assert.equal(stored, 1500);
  // 狭い窓で読み込んでも値そのものは保つ (広げ直したときに選んだ幅へ戻す)
  const narrow = sessionFilesPanelBounds(900, dockedMainWidth(900));
  assert.equal(sessionFilesPanelWidth(stored, narrow), 328);
});

class MemoryStorage implements SessionFilesPanelWidthStorage {
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
  const store = createSessionFilesPanelWidthStore(storage);
  assert.equal(store.read(), null);
  store.write(500);
  assert.equal(storage.value, "500");
  assert.equal(store.read(), 500);
  // 壊れた保存値は未設定へ落ちる
  storage.value = "500.5";
  assert.equal(createSessionFilesPanelWidthStore(storage).read(), null);
  store.write(null);
  assert.equal(storage.value, null);
  assert.equal(store.read(), null);
});

test("保存領域が使えない環境でも操作を止めない (session 内のメモリで保つ)", () => {
  const throwing: SessionFilesPanelWidthStorage = {
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
  const store = createSessionFilesPanelWidthStore(throwing);
  assert.equal(store.read(), null);
  store.write(500);
  assert.equal(store.read(), 500);
  store.write(null);
  assert.equal(store.read(), null);
  // storage が無い (window が無い) ときも同じ
  const none = createSessionFilesPanelWidthStore(null);
  none.write(500);
  assert.equal(none.read(), 500);
});
