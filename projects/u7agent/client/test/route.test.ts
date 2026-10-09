// pathname → 画面 → pathname の表。クエリ・フラグメントは pathname の契約外なので境界側で扱う。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_ROUTE,
  entrySpaceOf,
  foldPendingEntry,
  parseRoute,
  pendingSessionIdOf,
  routePath,
  sessionEntryHref,
  withoutEntrySpace,
  type Route,
} from "../src/lib/route";
import { SETTINGS_SECTIONS, type ModelsSubsection, type SettingsSection } from "../src/lib/settingsNav";

const settings = (section: SettingsSection): Route => ({ view: "settings", section });

/** 設定 → モデルのタブ。既定タブ (models) は URL のパスに出さない */
const modelsTab = (modelsSubsection: ModelsSubsection): Route => ({
  view: "settings",
  section: "models",
  modelsSubsection,
});

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
    ["/settings/spaces", settings("spaces")],
    ["/settings/skills", settings("skills")],
    ["/settings/appearance", settings("appearance")],
    ["/settings/models", settings("models")],
    ["/settings/runtime", settings("runtime")],
    ["/settings/notifications", settings("notifications")],
    ["/Settings/RUNTIME/", settings("runtime")],
    // コンテンツ生成と Web 検索はモデルの下ではなくルートのセクション
    ["/settings/content", settings("content")],
    ["/Settings/CONTENT/", settings("content")],
    ["/settings%2Fcontent", settings("content")],
    ["/settings/web-search", settings("web-search")],
    ["/Settings/WEB-SEARCH/", settings("web-search")],
    ["//settings//web-search//", settings("web-search")],
    // 設定 → モデルのタブ。正準形は「モデルを選ぶ」= /settings/models、「プロバイダー」= /providers
    ["/settings/models/providers", modelsTab("providers")],
    ["/Settings/MODELS/PROVIDERS/", modelsTab("providers")],
    ["//settings//models//providers//", modelsTab("providers")],
    ["/settings%2Fmodels%2Fproviders", modelsTab("providers")],
    // 未知のサブセクションと既定タブの明示は既定タブへ畳む (チャットへ飛ばさない)。
    // 旧 URL のエイリアスは足さないので、元タブのパスもここで既定タブへ畳まれる
    ["/settings/models/models", settings("models")],
    ["/settings/models/unknown", settings("models")],
    ["/settings/models/content", settings("models")],
    ["/Settings/MODELS/CONTENT/", settings("models")],
    ["/settings/models/web-search", settings("models")],
    ["/Settings/MODELS/WEB-SEARCH/", settings("models")],
    ["/settings/models/PROVIDERS/unknown", CHAT_ROUTE],
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
      "/settings/spaces",
      "/settings/agents",
      "/settings/skills",
      "/settings/models",
      "/settings/content",
      "/settings/web-search",
      "/settings/notifications",
      "/settings/appearance",
      "/settings/files",
      "/settings/archive",
      "/settings/runtime",
    ],
  );
  for (const item of SETTINGS_SECTIONS) {
    const route = settings(item.section);
    assert.deepEqual(parseRoute(routePath(route)), route, item.section);
  }
  // モデルのタブは既定タブ以外をパスへ出し、既定タブは出さない
  assert.equal(routePath(modelsTab("providers")), "/settings/models/providers");
  assert.equal(routePath(modelsTab("models")), "/settings/models");
  assert.deepEqual(parseRoute(routePath(modelsTab("providers"))), modelsTab("providers"));
  // コンテンツ生成と Web 検索はルートのセクションとして往復する
  for (const section of ["content", "web-search"] as const) {
    assert.equal(routePath(settings(section)), `/settings/${section}`);
    assert.deepEqual(parseRoute(routePath(settings(section))), settings(section));
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

test("`/s/<id>` の `space` だけを読み、他の画面と他のクエリは解釈しない", () => {
  assert.equal(entrySpaceOf(entry("abc123"), "?space=space-1111111111111111"), "space-1111111111111111");
  assert.equal(entrySpaceOf(entry("abc123"), "?space=default"), "default");
  assert.equal(entrySpaceOf(entry("abc123"), "?x=1&space=demo"), "demo");
  // 値が空・欠落なら無いものとして扱う (保存値で解決する)
  assert.equal(entrySpaceOf(entry("abc123"), ""), null);
  assert.equal(entrySpaceOf(entry("abc123"), "?space="), null);
  assert.equal(entrySpaceOf(entry("abc123"), "?other=demo"), null);
  // 入口以外では pathname と同じく解釈しない
  assert.equal(entrySpaceOf(CHAT_ROUTE, "?space=demo"), null);
  assert.equal(entrySpaceOf(settings("spaces"), "?space=demo"), null);
  // 不正な値も「不正な指定」として渡し、通常スペースへ黙って落とさない
  assert.equal(entrySpaceOf(entry("abc123"), "?space=../bad"), "../bad");
});

test("入口の `space` キーだけを落とし、他のクエリは書き方ごと残す", () => {
  assert.equal(withoutEntrySpace(entry("abc123"), "?space=demo"), "");
  assert.equal(withoutEntrySpace(entry("abc123"), "?space=demo&x=1"), "?x=1");
  assert.equal(withoutEntrySpace(entry("abc123"), "?x=1&space=demo&y=2"), "?x=1&y=2");
  assert.equal(withoutEntrySpace(entry("abc123"), "?x=1&space="), "?x=1");
  // 他のクエリのパーセントエンコーディングは組み直さない
  assert.equal(withoutEntrySpace(entry("abc123"), "?x=%20b&space=demo"), "?x=%20b");
  // 解釈できないキーは落とさない (他のクエリを壊すより残す)
  assert.equal(withoutEntrySpace(entry("abc123"), "?%zz=1&space=demo"), "?%zz=1");
  // 入口以外と `space` を持たない URL はそのまま (クエリは解釈も破棄もしない)
  for (const search of ["", "?space=demo", "?x=1&y=%20"]) {
    assert.equal(withoutEntrySpace(CHAT_ROUTE, search), search);
    assert.equal(withoutEntrySpace(settings("files"), search), search);
  }
});

test("会話を指定して開くリンクは所属スペースを載せ、不明なら載せない", () => {
  assert.equal(sessionEntryHref("abc123"), "/s/abc123");
  assert.equal(sessionEntryHref("a b"), "/s/a%20b");
  assert.equal(sessionEntryHref("a b", "default"), "/s/a%20b?space=default");
  assert.equal(sessionEntryHref("abc123", "space-1111111111111111"), "/s/abc123?space=space-1111111111111111");
});
