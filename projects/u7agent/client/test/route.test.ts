// pathname → 画面 → pathname の表。クエリ・フラグメントは pathname の契約外なので境界側で扱う。
import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ROUTE, parseRoute, routePath, type Route } from "../src/lib/route";
import { SETTINGS_SECTIONS, type SettingsSection } from "../src/lib/settingsNav";

const settings = (section: SettingsSection): Route => ({ view: "settings", section });

test("parseRoute は pathname だけで画面を決め、表のとおりに畳む", () => {
  const table: [string, Route][] = [
    // チャット
    ["/", CHAT_ROUTE],
    ["", CHAT_ROUTE],
    ["/nope", CHAT_ROUTE],
    ["/settings", CHAT_ROUTE],
    ["/settings/", CHAT_ROUTE],
    ["/settings/unknown", CHAT_ROUTE],
    ["/settings/files/extra", CHAT_ROUTE],
    // クエリ・フラグメントは pathname に含めない契約 (含めると画面として解釈できない)
    ["/nope#foo", CHAT_ROUTE],
    ["/settings/files?x=1", CHAT_ROUTE],
    // 不正な percent encoding は解釈不能としてチャットへ
    ["/%zz", CHAT_ROUTE],
    // 設定 (大文字・末尾スラッシュ・連続スラッシュ・percent encoding は正準形へ畳む)
    ["/settings/files", settings("files")],
    ["/settings/files/", settings("files")],
    ["/Settings/FILES", settings("files")],
    ["//settings//files//", settings("files")],
    ["/settings%2Ffiles", settings("files")],
    ["/settings/agents", settings("agents")],
    ["/settings/skills", settings("skills")],
    ["/settings/appearance", settings("appearance")],
    ["/settings/runtime", settings("runtime")],
    ["/settings/notifications", settings("notifications")],
    ["/Settings/RUNTIME/", settings("runtime")],
  ];
  for (const [pathname, expected] of table) {
    assert.deepEqual(parseRoute(pathname), expected, pathname);
  }
});

test("routePath は正準形を返し、parseRoute と往復する", () => {
  assert.equal(routePath(CHAT_ROUTE), "/");
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => routePath({ view: "settings", section: item.section })),
    [
      "/settings/agents",
      "/settings/skills",
      "/settings/files",
      "/settings/appearance",
      "/settings/runtime",
      "/settings/notifications",
    ],
  );
  for (const item of SETTINGS_SECTIONS) {
    const route = settings(item.section);
    assert.deepEqual(parseRoute(routePath(route)), route, item.section);
  }
});
