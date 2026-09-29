// 左バー (Sidebar) の幅の規則。client に DOM テスト基盤が無いため、bounds・clamp・キー操作・
// 保存値の扱いを純関数で固定し、ハンドルの配線と App / Sidebar の配線はソース走査・SSR で固定する。
//   1. bounds は定数 (既定 252 / 上限 400) で、viewport に依存しない
//   2. 上限は docked の下限 (1200px) でチャットと右パネルが潰れない値にする
//   3. 保存値は整数のみ。壊れた値は未設定へ落とし、bounds の外でも捨てない (表示時に clamp する)
//   4. ハンドルは resize を渡した Sidebar (docked) だけに出る (overlay のドロワーには出ない)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Sidebar } from "../src/components/Sidebar";
import type { SidebarResize } from "../src/hooks/useSidebarWidth";
import { SIDEBAR_OVERLAY_WIDTH, SIDEBAR_WIDTH } from "../src/lib/layout";
import {
  SESSION_FILES_CHAT_MIN_WIDTH,
  SESSION_FILES_WIDTH_DEFAULT_MAX,
  SESSION_FILES_WIDTH_DEFAULT_RATIO,
} from "../src/lib/sessionFilesPanel";
import {
  clampSidebarWidth,
  createSidebarWidthStore,
  parseSidebarWidth,
  sidebarWidth,
  sidebarWidthBounds,
  stepSidebarWidth,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STORE_LIMIT,
  type SidebarWidthStorage,
} from "../src/lib/sidebarWidth";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("bounds は定数で、下限は既定幅 (252px) / 上限は 400px", () => {
  assert.equal(SIDEBAR_WIDTH, 252);
  assert.equal(SIDEBAR_WIDTH_MAX, 400);
  assert.equal(SIDEBAR_WIDTH_STEP, 16);
  assert.equal(SIDEBAR_WIDTH_STORE_LIMIT, 2000);
  assert.equal(SIDEBAR_WIDTH_KEY, "u7agent-sidebar-width");
  assert.deepEqual(sidebarWidthBounds(), { min: 252, max: 400 });
});

test("上限は docked の下限 (1200px) でチャットと右パネルが潰れない値にする", () => {
  // 右パネルの下限 (min(360px, 30vw))。1200px では 360px
  const panelMin = Math.min(SESSION_FILES_WIDTH_DEFAULT_MAX, SIDEBAR_OVERLAY_WIDTH * SESSION_FILES_WIDTH_DEFAULT_RATIO);
  assert.equal(panelMin, 360);
  // 1200px: 左バー 400 / main 800 / 右パネル 360 / チャット 440 (下限 320 以上)
  assert.ok(
    SIDEBAR_OVERLAY_WIDTH - SIDEBAR_WIDTH_MAX >= panelMin + SESSION_FILES_CHAT_MIN_WIDTH,
    "上限を広げると docked の下限でチャットが 320px を割る",
  );
});

test("表示幅は clamp 済みで、未指定 (null) は既定幅 = 下限になる", () => {
  const bounds = sidebarWidthBounds();
  assert.equal(sidebarWidth(null, bounds), 252);
  assert.equal(sidebarWidth(300, bounds), 300);
  assert.equal(sidebarWidth(4000, bounds), 400);
  assert.equal(sidebarWidth(10, bounds), 252);
  // 端数は丸める (保存値 / aria-valuenow と揃える)
  assert.equal(clampSidebarWidth(300.6, bounds), 301);
});

test("キーボードの 1 歩は 16px で、端では止まる", () => {
  const bounds = sidebarWidthBounds();
  assert.equal(stepSidebarWidth(300, SIDEBAR_WIDTH_STEP, bounds), 316);
  assert.equal(stepSidebarWidth(300, -SIDEBAR_WIDTH_STEP, bounds), 284);
  assert.equal(stepSidebarWidth(bounds.max, SIDEBAR_WIDTH_STEP, bounds), bounds.max);
  assert.equal(stepSidebarWidth(bounds.min, -SIDEBAR_WIDTH_STEP, bounds), bounds.min);
});

test("保存値は整数だけを採り、壊れていれば未設定として捨てる", () => {
  assert.equal(parseSidebarWidth("300"), 300);
  assert.equal(parseSidebarWidth(String(SIDEBAR_WIDTH_STORE_LIMIT)), 2000);
  // 0 以下 / 端数 / 極端な値 / 数値でない値 / 前後の空白
  assert.equal(parseSidebarWidth("0"), null);
  assert.equal(parseSidebarWidth("-5"), null);
  assert.equal(parseSidebarWidth("300.5"), null);
  assert.equal(parseSidebarWidth(String(SIDEBAR_WIDTH_STORE_LIMIT + 1)), null);
  assert.equal(parseSidebarWidth("wide"), null);
  assert.equal(parseSidebarWidth(" 300"), null);
  assert.equal(parseSidebarWidth(""), null);
  assert.equal(parseSidebarWidth(null), null);
});

test("保存値が今の bounds の外でも捨てない (表示側で clamp するだけ)", () => {
  const stored = parseSidebarWidth("500");
  assert.equal(stored, 500);
  // bounds が定数でも値そのものは保つ (将来 bounds を広げたときに選んだ幅へ戻せる)
  assert.equal(sidebarWidth(stored, sidebarWidthBounds()), 400);
});

class MemoryStorage implements SidebarWidthStorage {
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
  const store = createSidebarWidthStore(storage);
  assert.equal(store.read(), null);
  store.write(320);
  assert.equal(storage.value, "320");
  assert.equal(store.read(), 320);
  // 壊れた保存値は未設定へ落ちる
  storage.value = "320.5";
  assert.equal(createSidebarWidthStore(storage).read(), null);
  store.write(null);
  assert.equal(storage.value, null);
  assert.equal(store.read(), null);
});

test("保存領域が使えない環境でも操作を止めない (session 内のメモリで保つ)", () => {
  const throwing: SidebarWidthStorage = {
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
  const store = createSidebarWidthStore(throwing);
  assert.equal(store.read(), null);
  store.write(320);
  assert.equal(store.read(), 320);
  store.write(null);
  assert.equal(store.read(), null);
  // storage が無い (window が無い) ときも同じ
  const none = createSidebarWidthStore(null);
  none.write(320);
  assert.equal(none.read(), 320);
});

const resize: SidebarResize = {
  width: 300,
  min: 252,
  max: 400,
  preview: () => {},
  commit: () => {},
  reset: () => {},
};

function renderSidebar(withResize: boolean): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      mode: "nav",
      onSelectMode: () => {},
      activeSettingsSection: "agents",
      notificationsFailed: false,
      sessions: [],
      sessionId: "",
      agents: [],
      projects: [],
      newChat: () => {},
      selectSession: () => {},
      renameSession: () => {},
      deleteSession: () => {},
      deleteProject: () => {},
      onNewProject: () => {},
      onOpenSettingsSection: () => {},
      variant: "sidebar",
      resize: withResize ? resize : undefined,
    }),
  );
}

test("ハンドルは resize を渡した Sidebar (docked) だけに出る", () => {
  const docked = renderSidebar(true);
  assert.ok(docked.includes('role="separator"'));
  assert.ok(docked.includes('aria-label="左バーの幅"'));
  assert.ok(docked.includes('aria-orientation="vertical"'));
  assert.ok(docked.includes('aria-valuemin="252"'));
  assert.ok(docked.includes('aria-valuemax="400"'));
  assert.ok(docked.includes('aria-valuenow="300"'));
  assert.ok(docked.includes('tabindex="0"'));
  assert.ok(docked.includes("panel-resize-handle"));
  // overlay のドロワー (NavSheet) は resize を渡さないのでハンドルが出ない
  const sheet = renderSidebar(false);
  assert.ok(!sheet.includes('role="separator"'));
  assert.ok(!sheet.includes("panel-resize-handle"));
});

test("ハンドルの配線: 終了経路をまとめ、移動ゼロでは commit しない", () => {
  const handle = read("src/components/sidebar/SidebarResizeHandle.tsx");
  assert.ok(handle.includes('role="separator"'));
  assert.ok(handle.includes('aria-orientation="vertical"'));
  assert.ok(handle.includes('aria-label="左バーの幅"'));
  assert.ok(handle.includes("aria-valuemin={min}"));
  assert.ok(handle.includes("aria-valuemax={max}"));
  assert.ok(handle.includes("aria-valuenow={width}"));
  assert.ok(handle.includes("tabIndex={0}"));
  assert.ok(handle.includes("setPointerCapture"));
  // 終了経路 (pointerup / pointercancel / lostpointercapture) はすべて finishDrag を通り、
  // 開始したポインターだけを受け付ける (別の指の同時タッチでドラッグを終わらせない)
  assert.equal(handle.match(/finishDrag\(event\.pointerId, true\)/g)?.length, 3);
  assert.ok(handle.includes("if (event.button !== 0 || dragRef.current) return;"));
  assert.ok(handle.includes("if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;"));
  assert.ok(handle.includes("if (commitWidth && drag.width !== drag.startWidth) commit(drag.width);"));
  // ダブルクリックは未指定 (既定幅) へ戻す
  assert.ok(handle.includes("onDoubleClick={reset}"));
});

test("ドラッグは右へ動かすと広がり、←→ は向きが逆で端で止まる", () => {
  const handle = read("src/components/sidebar/SidebarResizeHandle.tsx");
  const moveHandler = handle.slice(handle.indexOf("const handlePointerMove"), handle.indexOf("const handleKeyDown"));
  // 右パネル (左端のハンドル) と逆に、右へ動かす = 幅を増やす
  assert.ok(moveHandler.includes("drag.startWidth + (event.clientX - drag.startX)"));
  assert.ok(moveHandler.includes("preview(next)"));
  assert.ok(moveHandler.includes('setAttribute("aria-valuenow", String(next))'));
  assert.ok(!moveHandler.includes("commit("));
  // キーボードは → で増え、← で減る。Home / End は下限 / 上限
  assert.ok(handle.includes('event.key === "ArrowRight" ? SIDEBAR_WIDTH_STEP : -SIDEBAR_WIDTH_STEP'));
  assert.ok(handle.includes('commit(event.key === "Home" ? min : max)'));
});

test("App は幅を CSS 変数で渡し、main の幅と右パネルの bounds に使う", () => {
  const app = read("src/App.tsx");
  assert.ok(app.includes('style={{ "--sidebar-width": `${sidebarWidth.width}px` } as CSSProperties}'));
  assert.ok(
    app.includes(
      'sidebarDocked ? "grid-cols-[var(--sidebar-width)_minmax(0,1fr)] grid-rows-1" : "grid-cols-1 grid-rows-1"',
    ),
  );
  assert.ok(app.includes("<Sidebar {...navProps} resize={sidebarWidth} />"));
  // 右パネルの bounds は左バーの実幅に追随する (SIDEBAR_WIDTH の import は式の変更で不要になる)
  assert.ok(app.includes("mainWidth: sidebarDocked ? viewportWidth - sidebarWidth.width : viewportWidth"));
  assert.ok(!app.includes("SIDEBAR_WIDTH"));
  const hook = read("src/hooks/useSidebarWidth.ts");
  assert.ok(hook.includes('shellRef.current?.style.setProperty("--sidebar-width"'));
  // 任意値クラスは oxlint の allow に足す (無いと lint が落ちる)
  assert.ok(read("../.oxlintrc.json").includes('"grid-cols-[var(--sidebar-width)_minmax(0,1fr)]"'));
});
