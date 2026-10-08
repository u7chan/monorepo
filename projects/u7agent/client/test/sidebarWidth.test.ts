import assert from "node:assert/strict";

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
      togglePinned: () => {},
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

  // overlay のドロワー (NavSheet) は resize を渡さないのでハンドルが出ない
  const sheet = renderSidebar(false);
  assert.ok(!sheet.includes('role="separator"'));
});
