// 設定のタブの表 (SETTINGS_TABS) と、それを引く URL ⇄ Route の関数。タブごとの一覧・並び・既定は
// settingsNav.test.ts、具体的な URL の読み替えは route.test.ts が持つので、ここは表を引く関数の契約
// (既定の省略・未知の畳み方・現在タブの取り出し・セクションとタブの対応) だけを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ROUTE, parseRoute, routePath, settingsTabOf, settingsTabRoute, type Route } from "../src/lib/route";
import {
  isSettingsTabSection,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  settingsTabSpec,
  type SettingsTabSection,
} from "../src/lib/settingsNav";

const TAB_SECTIONS = Object.keys(SETTINGS_TABS) as SettingsTabSection[];

test("表はタブを持つセクションだけを持ち、既定は一覧の先頭にある", () => {
  assert.deepEqual([...TAB_SECTIONS].sort(), ["appearance", "content", "files", "models", "runtime", "sharing"]);
  for (const section of TAB_SECTIONS) {
    const spec = settingsTabSpec(section);
    assert.equal(spec.defaultSubsection, spec.items[0].subsection, section);
    assert.ok(spec.items.length > 1, `${section} はタブに分ける面を持つ`);
    assert.equal(isSettingsTabSection(section), true, section);
    // 表のセクションは設定ナビに載っている (画面の無いタブを作らない)
    assert.ok(
      SETTINGS_SECTIONS.some((item) => item.section === section),
      section,
    );
  }
  // タブを持たないセクションは表に無い。タブを持つ画面にするときは表へ足す
  assert.deepEqual(
    SETTINGS_SECTIONS.filter((item) => !isSettingsTabSection(item.section)).map((item) => item.section),
    [
      "spaces",
      "agents",
      "prompts",
      "skills",
      "web-search",
      "voice-input",
      "session-title",
      "notifications",
      "git",
      "backup",
    ],
  );
});

test("タブを選ぶ route は既定タブを省略し、それ以外はそのセクションのフィールドに載せる", () => {
  for (const section of TAB_SECTIONS) {
    const spec = settingsTabSpec(section);
    for (const { subsection } of spec.items) {
      const route = settingsTabRoute(section, subsection);
      const path =
        subsection === spec.defaultSubsection ? `/settings/${section}` : `/settings/${section}/${subsection}`;
      assert.equal(routePath(route), path, `${section}/${subsection}`);
      assert.deepEqual(parseRoute(path), route, `${section}/${subsection}`);
      assert.equal(settingsTabOf(route, section), subsection, `${section}/${subsection}`);
      // 載せるフィールドはそのセクションの 1 つだけ (既定タブは載せない)
      assert.deepEqual(
        Object.keys(route).sort(),
        (subsection === spec.defaultSubsection ? ["section", "view"] : ["section", spec.field, "view"]).sort(),
        `${section}/${subsection}`,
      );
    }
  }
});

test("現在のタブは、載っていない既定タブ・別のセクション・設定以外の画面では既定へ畳む", () => {
  assert.equal(settingsTabOf({ view: "settings", section: "files" }, "files"), "files");
  assert.equal(settingsTabOf({ view: "settings", section: "files", filesSubsection: "archive" }, "files"), "archive");
  // セクションが違う route は、その画面を開いていないものとして既定のタブを返す
  assert.equal(settingsTabOf({ view: "settings", section: "sharing" }, "files"), "files");
  assert.equal(
    settingsTabOf({ view: "settings", section: "files", filesSubsection: "archive" }, "sharing"),
    "contents",
  );
  assert.equal(settingsTabOf(CHAT_ROUTE, "runtime"), "service");
  assert.equal(settingsTabOf({ view: "activity" }, "models"), "models");
});

test("セクションとタブの不整合は型で作れない", () => {
  // 型検査だけのテスト (実行時は何もしない)。`@ts-expect-error` が余ると typecheck が落ちるので、
  // 作れないことをここで固定する。route.test.ts の表はフィールド名を保ったまま通る
  // @ts-expect-error タブを持たないセクションにはタブを載せられない
  const noTabs: Route = { view: "settings", section: "git", modelsSubsection: "providers" };
  // @ts-expect-error 別セクションのタブは載せられない
  const otherSectionTab: Route = { view: "settings", section: "models", contentSubsection: "bgm" };
  // @ts-expect-error タブの値もセクションに合うものだけ
  const otherSectionValue = settingsTabRoute("models", "connections");
  void [noTabs, otherSectionTab, otherSectionValue];
});
