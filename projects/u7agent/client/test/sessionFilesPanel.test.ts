// 右パネル (作業フォルダ) の幅の規則。client に DOM テスト基盤が無いため、境界・clamp・
// キー操作・保存値の扱いを純関数で固定し、ハンドルの配線はソース走査で固定する。
//   1. bounds は viewport と main 列 (左バーを引いた残り) で決まる。mainWidth を渡し直すだけで
//      overlay 配置 (#1541) にも追随する
//   2. min == max の幅 (720px) ではハンドルを出さない
//   3. 保存値は整数のみ。壊れた値は未設定へ落とし、bounds の外でも捨てない (表示時に clamp する)
//   4. 移動ゼロのドラッグは commit しない (保存もしない) / 終了経路は pointerup, pointercancel,
//      lostpointercapture (と unmount) の 1 か所へまとめる
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/** desktop で左バー (252px) が docked のときの main 列の幅 */
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

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

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

test("ハンドルの配線: 終了経路をまとめ、移動ゼロでは commit しない", () => {
  const panel = read("src/components/SessionFilesPanel.tsx");
  assert.ok(panel.includes('role="separator"'));
  assert.ok(panel.includes('aria-orientation="vertical"'));
  assert.ok(panel.includes('aria-label="作業フォルダの幅"'));
  assert.ok(panel.includes("aria-valuemin={min}"));
  assert.ok(panel.includes("aria-valuemax={max}"));
  assert.ok(panel.includes("aria-valuenow={width}"));
  assert.ok(panel.includes("tabIndex={0}"));
  assert.ok(panel.includes("setPointerCapture"));
  // 終了経路 (pointerup / pointercancel / lostpointercapture) はすべて finishDrag を通り、
  // 開始したポインターだけを受け付ける (別の指の同時タッチでドラッグを終わらせない)
  assert.equal(panel.match(/finishDrag\(event\.pointerId, true\)/g)?.length, 3);
  assert.ok(panel.includes("if (event.button !== 0 || dragRef.current) return;"));
  assert.ok(panel.includes("if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;"));
  assert.ok(panel.includes("if (commitWidth && drag.width !== drag.startWidth) commit(drag.width);"));
  // ダブルクリックは未指定へ戻す / min == max ではハンドルごと出さない
  assert.ok(panel.includes("onDoubleClick={reset}"));
  assert.ok(panel.includes("{resize.resizable ? <SessionFilesResizeHandle {...resize} /> : null}"));
});

test("ドラッグ中は再描画せず、CSS 変数と aria-valuenow だけを動かす", () => {
  const panel = read("src/components/SessionFilesPanel.tsx");
  const moveHandler = panel.slice(panel.indexOf("const handlePointerMove"), panel.indexOf("const handleKeyDown"));
  // 開始幅からの絶対計算にする (clamp で端に貼り付いても、戻せば追従する)
  assert.ok(moveHandler.includes("drag.startWidth - (event.clientX - drag.startX)"));
  assert.ok(moveHandler.includes("preview(next)"));
  assert.ok(moveHandler.includes('setAttribute("aria-valuenow", String(next))'));
  assert.ok(!moveHandler.includes("commit("));

  const app = read("src/App.tsx");
  assert.ok(app.includes('style={{ "--session-files-width": `${panelWidth.width}px` } as CSSProperties}'));
  assert.ok(app.includes('filesPanelOpen ? "grid-cols-[minmax(0,1fr)_var(--session-files-width)]" : "grid-cols-1"'));
  assert.ok(app.includes("resize={panelWidth}"));
  const hook = read("src/hooks/useSessionFilesPanelWidth.ts");
  assert.ok(hook.includes('mainRef.current?.style.setProperty("--session-files-width"'));
  // ドラッグ中はカーソルを保ち、テキスト選択を止める
  assert.ok(read("src/styles/index.css").includes("body.is-resizing-panel"));
});
