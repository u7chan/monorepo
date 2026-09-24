// pathname → 画面 → pathname の表。クエリ・フラグメントは pathname の契約外なので境界側で扱う。
import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ROUTE, foldPendingEntry, parseRoute, pendingSessionIdOf, routePath, type Route } from "../src/lib/route";
import { SETTINGS_SECTIONS, type SettingsSection } from "../src/lib/settingsNav";

const settings = (section: SettingsSection): Route => ({ view: "settings", section });

/** 通知のリンク (`/s/<id>`) が作る「選択待ちの入口」。チャット画面 + 消費されるまでの id */
const entry = (pendingSessionId: string): Route => ({ view: "chat", pendingSessionId });

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
    ["/s/%zz", CHAT_ROUTE],
    // 通知のリンク。id が無い / セグメントが余る / id に `/` を含む形は入口にしない
    ["/s", CHAT_ROUTE],
    ["/s/", CHAT_ROUTE],
    ["/s/a/b", CHAT_ROUTE],
    ["/s/a%2Fb", CHAT_ROUTE],
    ["/s/abc123", entry("abc123")],
    ["/s/abc123/", entry("abc123")],
    ["//s//abc123//", entry("abc123")],
    ["/S/abc123", entry("abc123")],
    // id は不透明な値。decode した生の値を持ち、URL へ戻すときに encode する
    ["/s/a%20b", entry("a b")],
    ["/s/%E3%82%BB%E3%83%83%E3%82%B7%E3%83%A7%E3%83%B3", entry("セッション")],
    // 設定 (大文字・末尾スラッシュ・連続スラッシュ・percent encoding は正準形へ畳む)
    ["/settings/files", settings("files")],
    ["/settings/archive", settings("archive")],
    ["/Settings/ARCHIVE/", settings("archive")],
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
      "/settings/archive",
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

test("routePath は `/s/<id>` を encode して返し、parseRoute と往復する", () => {
  assert.equal(routePath(entry("abc123")), "/s/abc123");
  assert.equal(routePath(entry("a b")), "/s/a%20b");
  for (const sessionId of ["abc123", "a b", "a+b", "セッション", "a%20b"]) {
    const route = entry(sessionId);
    assert.deepEqual(parseRoute(routePath(route)), route, sessionId);
  }
});

test("選択待ちの入口は URL を保ち、選択が確定したらチャットへ畳む", () => {
  const pending = parseRoute("/s/abc123");
  // mount 時の正準化は routePath(parseRoute(pathname)) の比較なので、ここが同じ間は URL が消えない
  assert.equal(routePath(parseRoute(routePath(pending))), "/s/abc123");
  assert.equal(pendingSessionIdOf(pending), "abc123");
  // 畳むのはチャットの正準形 (履歴を増やさない replaceState は呼び出し側が行う)
  assert.equal(foldPendingEntry(pending), CHAT_ROUTE);
  assert.equal(routePath(foldPendingEntry(pending)), "/");
});

test("入口を持たない route は畳まず、同じ object を返す", () => {
  assert.equal(pendingSessionIdOf(CHAT_ROUTE), undefined);
  assert.equal(pendingSessionIdOf(settings("agents")), undefined);
  assert.equal(foldPendingEntry(CHAT_ROUTE), CHAT_ROUTE);
  const section = settings("agents");
  assert.equal(foldPendingEntry(section), section);
});
