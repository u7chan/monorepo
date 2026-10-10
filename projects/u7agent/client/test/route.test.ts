// pathname → 画面 → pathname の表。クエリ・フラグメントは pathname の契約外なので境界側で扱う。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_ROUTE,
  entryResolvedInitially,
  entrySpaceOf,
  parseRoute,
  routePath,
  sessionEntryHref,
  sessionIdOf,
  sessionPath,
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

/** 会話を指定した URL (`/s/<id>`) の route。id は不透明な値で、URL へ戻すときだけ encode する */
const sessionUrl = (sessionId: string): Route => ({ view: "chat", sessionId });

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
    ["/s/abc123", sessionUrl("abc123")],
    ["/s/abc123/", sessionUrl("abc123")],
    ["//s//abc123//", sessionUrl("abc123")],
    ["/S/abc123", sessionUrl("abc123")],
    // id は不透明な値。decode した生の値を持ち、URL へ戻すときに encode する
    ["/s/a%20b", sessionUrl("a b")],
    ["/s/%E3%82%BB%E3%83%83%E3%82%B7%E3%83%A7%E3%83%B3", sessionUrl("セッション")],
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
  assert.equal(routePath(sessionUrl("abc123")), "/s/abc123");
  assert.equal(routePath(sessionUrl("a b")), "/s/a%20b");
  for (const sessionId of ["abc123", "a b", "a+b", "セッション", "a%20b"]) {
    const route = sessionUrl(sessionId);
    assert.deepEqual(parseRoute(routePath(route)), route, sessionId);
  }
});

test("同期は確定した選択を URL に映し、書かない条件では null を返す", () => {
  const table: [Route["view"], string | undefined, string, boolean, string | null][] = [
    // 設定の表示中は書かない (SSE 切断や削除で選択が変わっても URL と表示を食い違わせない)
    ["settings", undefined, "", true, null],
    ["settings", "abc123", "abc123", true, null],
    ["settings", "abc123", "xyz789", false, null],
    // 未解決の入口が未選択のままの間は URL を保つ (一覧の取得に失敗しても、次の一覧で解決する)
    ["chat", "abc123", "", false, null],
    // 未解決でも、ユーザー操作で選択が確定したらその選択を書く
    ["chat", "abc123", "xyz789", false, "/s/xyz789"],
    ["chat", undefined, "xyz789", false, "/s/xyz789"],
    // 解決後は確定した選択へ揃え、未選択は `/` へ戻す
    ["chat", "abc123", "xyz789", true, "/s/xyz789"],
    ["chat", "abc123", "", true, "/"],
    ["chat", undefined, "xyz789", true, "/s/xyz789"],
    // URL と同じ (会話なし同士も含む) ときは書き直さない
    ["chat", "abc123", "abc123", true, null],
    ["chat", undefined, "", true, null],
    ["chat", "abc123", "abc123", false, null],
    // undefined (会話 ID なし) と "" (選択なし) は同じ「会話なし」に正規化する (未選択を /s/ と書かない)
    ["chat", "", "", true, null],
    ["chat", "", "abc123", true, "/s/abc123"],
  ];
  for (const [view, urlSessionId, selectedSessionId, entryResolved, expected] of table) {
    assert.equal(
      sessionPath(view, urlSessionId, selectedSessionId, entryResolved),
      expected,
      `${view} url=${urlSessionId} selected=${selectedSessionId} resolved=${entryResolved}`,
    );
  }
  // 会話 ID は不透明な値として encode する
  assert.equal(sessionPath("chat", undefined, "a b", true), "/s/a%20b");
});

test("URL が指定する会話を返し、入口の解決状態は会話の有無から決まる", () => {
  assert.equal(sessionIdOf(CHAT_ROUTE), undefined);
  assert.equal(sessionIdOf(sessionUrl("abc123")), "abc123");
  assert.equal(sessionIdOf(settings("agents")), undefined);
  // 会話を指定していない URL には保つ URL が無いので、最初から解決済みとする
  assert.equal(entryResolvedInitially(undefined), true);
  assert.equal(entryResolvedInitially("abc123"), false);
});

test("`/s/<id>` の `space` だけを読み、他の画面と他のクエリは解釈しない", () => {
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?space=space-1111111111111111"), "space-1111111111111111");
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?space=default"), "default");
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?x=1&space=demo"), "demo");
  // 値が空・欠落なら無いものとして扱う (保存値で解決する)
  assert.equal(entrySpaceOf(sessionUrl("abc123"), ""), null);
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?space="), null);
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?other=demo"), null);
  // 会話を指定しない画面では pathname と同じく解釈しない
  assert.equal(entrySpaceOf(CHAT_ROUTE, "?space=demo"), null);
  assert.equal(entrySpaceOf(settings("spaces"), "?space=demo"), null);
  // 不正な値も「不正な指定」として渡し、通常スペースへ黙って落とさない
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?space=../bad"), "../bad");
});

test("会話を指定した URL の `space` キーだけを落とし、他のクエリは書き方ごと残す", () => {
  assert.equal(withoutEntrySpace(sessionUrl("abc123"), "?space=demo"), "");
  assert.equal(withoutEntrySpace(sessionUrl("abc123"), "?space=demo&x=1"), "?x=1");
  assert.equal(withoutEntrySpace(sessionUrl("abc123"), "?x=1&space=demo&y=2"), "?x=1&y=2");
  assert.equal(withoutEntrySpace(sessionUrl("abc123"), "?x=1&space="), "?x=1");
  // 他のクエリのパーセントエンコーディングは組み直さない
  assert.equal(withoutEntrySpace(sessionUrl("abc123"), "?x=%20b&space=demo"), "?x=%20b");
  // 解釈できないキーは落とさない (他のクエリを壊すより残す)
  assert.equal(withoutEntrySpace(sessionUrl("abc123"), "?%zz=1&space=demo"), "?%zz=1");
  // 会話を指定しない URL と `space` を持たない URL はそのまま (クエリは解釈も破棄もしない)
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
