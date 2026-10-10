import assert from "node:assert/strict";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { Sidebar } from "../src/components/Sidebar";
import {
  createSidebarSectionsStore,
  decodeExpandedSidebarSections,
  encodeExpandedSidebarSections,
  SIDEBAR_SECTIONS_KEY,
  SIDEBAR_SECTIONS_VERSION,
  type SidebarSectionsStorage,
} from "../src/lib/sidebarSections";

class MemoryStorage implements SidebarSectionsStorage {
  value: string | null = null;
  lastKey: string | null = null;

  getItem(key: string): string | null {
    this.lastKey = key;
    return this.value;
  }

  setItem(key: string, value: string): void {
    this.lastKey = key;
    this.value = value;
  }
}

test("カテゴリの保存値が無い場合は Projects と未所属を開き、既存の表示を保つ", () => {
  assert.deepEqual(decodeExpandedSidebarSections(null), ["projects", "unassigned"]);

  const html = renderToStaticMarkup(
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
      moveSession: () => {},
      deleteSession: () => {},
      deleteProject: () => {},
      togglePinned: () => {},
      onNewProject: () => {},
      onOpenSettingsSection: () => {},
    }),
  );

  assert.match(html, /aria-expanded="true" aria-controls="sidebar-projects-content"/);
  assert.match(html, /aria-expanded="true" aria-controls="sidebar-unassigned-content"/);
  assert.match(html, /id="sidebar-projects-content" class="tree-fold" data-open="true"/);
  assert.match(html, /id="sidebar-unassigned-content" class="tree-fold" data-open="true"/);
});

test("カテゴリの開閉状態は検証して保存し、再 mount 後も復元する", () => {
  const storage = new MemoryStorage();
  const store = createSidebarSectionsStore(storage);

  assert.deepEqual(store.read(), ["projects", "unassigned"]);
  store.write(["unassigned", "unassigned"]);
  assert.equal(storage.lastKey, SIDEBAR_SECTIONS_KEY);
  assert.equal(storage.value, encodeExpandedSidebarSections(["unassigned"]));
  assert.deepEqual(createSidebarSectionsStore(storage).read(), ["unassigned"]);

  store.write([]);
  assert.deepEqual(decodeExpandedSidebarSections(storage.value), []);
  assert.equal(SIDEBAR_SECTIONS_VERSION, 1);
});

test("壊れた保存値や利用できない storage でもカテゴリを操作できる", () => {
  assert.deepEqual(decodeExpandedSidebarSections("{"), ["projects", "unassigned"]);
  assert.deepEqual(
    decodeExpandedSidebarSections(JSON.stringify({ version: SIDEBAR_SECTIONS_VERSION + 1, expanded: [] })),
    ["projects", "unassigned"],
  );
  assert.deepEqual(
    decodeExpandedSidebarSections(
      JSON.stringify({ version: SIDEBAR_SECTIONS_VERSION, expanded: ["unassigned", "other", "unassigned", 1] }),
    ),
    ["unassigned"],
  );

  const throwing: SidebarSectionsStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  const store = createSidebarSectionsStore(throwing);
  store.write(["projects"]);
  assert.deepEqual(store.read(), ["projects"]);
});
