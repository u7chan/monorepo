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
  withEntrySpace,
  type Route,
} from "../src/lib/route";
import {
  SETTINGS_SECTIONS,
  type AppearanceSubsection,
  type ContentSubsection,
  type FilesSubsection,
  type ModelsSubsection,
  type RuntimeSubsection,
  type SettingsSection,
  type SharingSubsection,
} from "../src/lib/settingsNav";

const settings = (section: SettingsSection): Route => ({ view: "settings", section });

/** 設定 → 外観のタブ。既定タブ (theme) は URL のパスに出さない */
const appearanceTab = (appearanceSubsection: AppearanceSubsection): Route => ({
  view: "settings",
  section: "appearance",
  appearanceSubsection,
});

/** 設定 → コンテンツ生成のタブ。既定タブ (image) は URL のパスに出さない */
const contentTab = (contentSubsection: ContentSubsection): Route => ({
  view: "settings",
  section: "content",
  contentSubsection,
});

/** 設定 → ファイルのタブ。既定タブ (files) は URL のパスに出さない */
const filesTab = (filesSubsection: FilesSubsection): Route => ({
  view: "settings",
  section: "files",
  filesSubsection,
});

/** 設定 → モデルのタブ。既定タブ (models) は URL のパスに出さない */
const modelsTab = (modelsSubsection: ModelsSubsection): Route => ({
  view: "settings",
  section: "models",
  modelsSubsection,
});

/** 設定 → ランタイムのタブ。既定タブ (service) は URL のパスに出さない */
const runtimeTab = (runtimeSubsection: RuntimeSubsection): Route => ({
  view: "settings",
  section: "runtime",
  runtimeSubsection,
});

/** 設定 → 共有のタブ。既定タブ (contents) は URL のパスに出さない */
const sharingTab = (sharingSubsection: SharingSubsection): Route => ({
  view: "settings",
  section: "sharing",
  sharingSubsection,
});

/** 会話を指定した URL (`/s/<id>`) の route。id は不透明な値で、URL へ戻すときだけ encode する */
const sessionUrl = (sessionId: string): Route => ({ view: "chat", sessionId });

/** 全スペース横断の実行状況 */
const ACTIVITY_ROUTE: Route = { view: "activity" };

test("parseRoute は pathname だけで画面を決め、表のとおりに畳む", () => {
  const table: [string, Route][] = [
    // チャット
    ["/", CHAT_ROUTE],
    ["", CHAT_ROUTE],
    ["/nope", CHAT_ROUTE],
    ["/settings", CHAT_ROUTE],
    ["/settings/", CHAT_ROUTE],
    ["/settings/unknown", CHAT_ROUTE],
    // クエリ・フラグメントは pathname に含めない契約 (含めると画面として解釈できない)
    ["/nope#foo", CHAT_ROUTE],
    ["/settings/files?x=1", CHAT_ROUTE],
    // 不正な percent encoding は解釈不能としてチャットへ
    ["/%zz", CHAT_ROUTE],
    ["/s/%zz", CHAT_ROUTE],
    // 実行状況。大文字・末尾スラッシュ・連続スラッシュ・percent encoding は正準形へ畳み、
    // 余分なセグメントはチャットへ戻す
    ["/activity", ACTIVITY_ROUTE],
    ["/Activity", ACTIVITY_ROUTE],
    ["/activity/", ACTIVITY_ROUTE],
    ["//activity//", ACTIVITY_ROUTE],
    ["/%61ctivity", ACTIVITY_ROUTE],
    ["/activity/extra", CHAT_ROUTE],
    ["/activities", CHAT_ROUTE],
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
    ["/settings/content/bgm", contentTab("bgm")],
    // 旧 設定 → ダウンロード (/settings/archive) はファイルの「ダウンロードの除外」タブへ読み替える
    ["/settings/archive", filesTab("archive")],
    ["/Settings/ARCHIVE/", filesTab("archive")],
    ["/settings/archive/extra", CHAT_ROUTE],
    ["/settings/files/", settings("files")],
    ["/Settings/FILES", settings("files")],
    ["//settings//files//", settings("files")],
    ["/settings%2Ffiles", settings("files")],
    ["/settings/agents", settings("agents")],
    ["/settings/spaces", settings("spaces")],
    ["/settings/skills", settings("skills")],
    ["/settings/appearance", settings("appearance")],
    // 設定 → 外観のタブ。既定タブ (テーマ) はパスへ出さず、未知のサブセクションも既定へ畳む
    ["/Settings/APPEARANCE/ICONS/", appearanceTab("icons")],
    ["//settings//appearance//icons//", appearanceTab("icons")],
    ["/settings%2Fappearance%2Ficons", appearanceTab("icons")],
    ["/settings/appearance/theme", settings("appearance")],
    ["/settings/appearance/unknown", settings("appearance")],
    ["/settings/appearance/icons/extra", CHAT_ROUTE],
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
    // 共有は既定タブ (共有コンテンツ) をパスへ出さない。既定タブの明示と未知のサブセクションは既定へ畳む
    ["/settings/sharing", settings("sharing")],
    ["/Settings/SHARING/", settings("sharing")],
    ["/settings/sharing/contents", settings("sharing")],
    ["/settings/sharing/exclusions", sharingTab("exclusions")],
    ["/settings/sharing/connections", sharingTab("connections")],
    ["/settings/sharing/unknown", settings("sharing")],
    ["/settings/sharing/connections/extra", CHAT_ROUTE],
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
    // 設定 → ファイルのタブ。正準形は「ファイルツリー」= /settings/files、「ダウンロードの除外」= /archive
    ["/settings/files/archive", filesTab("archive")],
    ["/Settings/FILES/ARCHIVE/", filesTab("archive")],
    ["//settings//files//archive//", filesTab("archive")],
    ["/settings%2Ffiles%2Farchive", filesTab("archive")],
    // 未知のサブセクションと既定タブの明示は既定タブへ畳む (チャットへ飛ばさない)
    ["/settings/files/files", settings("files")],
    ["/settings/files/unknown", settings("files")],
    ["/settings/files/archive/extra", CHAT_ROUTE],
    // 設定 → ランタイムのタブ。正準形は「サービス」= /settings/runtime、「環境」= /environment、「診断」= /diagnostics
    ["/settings/runtime/environment", runtimeTab("environment")],
    ["/settings/runtime/diagnostics", runtimeTab("diagnostics")],
    ["/Settings/RUNTIME/ENVIRONMENT/", runtimeTab("environment")],
    ["//settings//runtime//diagnostics//", runtimeTab("diagnostics")],
    ["/settings%2Fruntime%2Fdiagnostics", runtimeTab("diagnostics")],
    // 未知のサブセクションと既定タブの明示は既定タブへ畳む (チャットへ飛ばさない)
    ["/settings/runtime/service", settings("runtime")],
    ["/settings/runtime/unknown", settings("runtime")],
    ["/settings/runtime/models", settings("runtime")],
    ["/Settings/RUNTIME/SERVICE/", settings("runtime")],
    ["/settings/runtime/environment/unknown", CHAT_ROUTE],
    ["/settings/runtime/diagnostics/extra", CHAT_ROUTE],
    // 設定 → コンテンツ生成のタブ。正準形は「画像生成」= /settings/content、「音声（TTS）」= /speech
    ["/settings/content/speech", contentTab("speech")],
    ["/Settings/CONTENT/SPEECH/", contentTab("speech")],
    ["//settings//content//speech//", contentTab("speech")],
    ["/settings%2Fcontent%2Fspeech", contentTab("speech")],
    // 未知のサブセクションと既定タブの明示は既定タブへ畳む (チャットへ飛ばさない)
    ["/settings/content/image", settings("content")],
    ["/settings/content/unknown", settings("content")],
    ["/settings/content/speech/extra", CHAT_ROUTE],
  ];
  for (const [pathname, expected] of table) {
    assert.deepEqual(parseRoute(pathname), expected, pathname);
  }
});

test("routePath は正準形を返し、parseRoute と往復する", () => {
  assert.equal(routePath(CHAT_ROUTE), "/");
  assert.equal(routePath(ACTIVITY_ROUTE), "/activity");
  assert.deepEqual(parseRoute(routePath(ACTIVITY_ROUTE)), ACTIVITY_ROUTE);
  assert.deepEqual(
    SETTINGS_SECTIONS.map((item) => routePath({ view: "settings", section: item.section })),
    [
      "/settings/spaces",
      "/settings/agents",
      "/settings/prompts",
      "/settings/skills",
      "/settings/models",
      "/settings/content",
      "/settings/web-search",
      "/settings/session-title",
      "/settings/sharing",
      "/settings/notifications",
      "/settings/appearance",
      "/settings/files",
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
  assert.deepEqual(parseRoute(routePath(modelsTab("providers"))), modelsTab("providers"));
  // 外観のタブも同じく、アイコンだけをパスへ出し、既定のテーマは出さない
  assert.equal(routePath(appearanceTab("icons")), "/settings/appearance/icons");
  assert.equal(routePath(appearanceTab("theme")), "/settings/appearance");
  assert.deepEqual(parseRoute(routePath(appearanceTab("icons"))), appearanceTab("icons"));
  assert.deepEqual(
    parseRoute(routePath(appearanceTab("theme"))),
    settings("appearance"),
    "既定タブはパスへ出さず、既定へ戻す",
  );
  // ファイルのタブも同じ規則で、旧 /settings/archive は除外タブの正準形へ畳む
  assert.equal(routePath(filesTab("archive")), "/settings/files/archive");
  assert.equal(routePath(filesTab("files")), "/settings/files");
  assert.deepEqual(parseRoute(routePath(filesTab("archive"))), filesTab("archive"));
  assert.deepEqual(parseRoute("/settings/archive"), filesTab("archive"));
  assert.equal(routePath(parseRoute("/settings/archive")), "/settings/files/archive");
  // ランタイムのタブも同じく既定タブ以外をパスへ出し、既定タブは出さない
  assert.equal(routePath(runtimeTab("environment")), "/settings/runtime/environment");
  assert.equal(routePath(runtimeTab("diagnostics")), "/settings/runtime/diagnostics");
  assert.equal(routePath(runtimeTab("service")), "/settings/runtime");
  for (const subsection of ["environment", "diagnostics"] as const) {
    assert.deepEqual(parseRoute(routePath(runtimeTab(subsection))), runtimeTab(subsection), subsection);
  }
  assert.deepEqual(
    parseRoute(routePath(runtimeTab("service"))),
    settings("runtime"),
    "既定タブはパスへ出さず、既定へ戻す",
  );
  // 共有のタブも同じく、公開の除外と接続だけをパスへ出し、既定の共有コンテンツは出さない
  assert.equal(routePath(sharingTab("connections")), "/settings/sharing/connections");
  assert.equal(routePath(sharingTab("exclusions")), "/settings/sharing/exclusions");
  assert.equal(routePath(sharingTab("contents")), "/settings/sharing");
  assert.deepEqual(parseRoute(routePath(sharingTab("connections"))), sharingTab("connections"));
  assert.deepEqual(parseRoute(routePath(sharingTab("exclusions"))), sharingTab("exclusions"));
  assert.deepEqual(
    parseRoute(routePath(sharingTab("contents"))),
    settings("sharing"),
    "既定タブはパスへ出さず、既定へ戻す",
  );
  // コンテンツ生成と Web 検索はルートのセクションとして往復する
  for (const section of ["content", "web-search"] as const) {
    assert.equal(routePath(settings(section)), `/settings/${section}`);
    assert.deepEqual(parseRoute(routePath(settings(section))), settings(section));
  }
  // コンテンツ生成のタブも同じ規則で、既定タブ以外をパスへ出し、既定タブは出さない
  assert.equal(routePath(contentTab("speech")), "/settings/content/speech");
  assert.equal(routePath(contentTab("image")), "/settings/content");
  assert.deepEqual(parseRoute(routePath(contentTab("speech"))), contentTab("speech"));
  assert.deepEqual(
    parseRoute(routePath(contentTab("image"))),
    settings("content"),
    "既定タブはパスへ出さず、既定へ戻す",
  );
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
  const table: [Route["view"], string, boolean, string | null][] = [
    // 設定と実行状況の表示中は書かない (SSE 切断や削除で選択が変わっても URL と表示を食い違わせない。
    // 実行状況は会話を指定しない画面なので、選択を載せると戻る先が変わってしまう)
    ["settings", "", true, null],
    ["settings", "abc123", true, null],
    ["settings", "xyz789", false, null],
    ["activity", "", true, null],
    ["activity", "abc123", true, null],
    // 未解決の入口が未選択のままの間は URL を保つ (一覧の取得に失敗しても、次の一覧で解決する)
    ["chat", "", false, null],
    // 未解決でも、ユーザー操作で選択が確定したらその選択を書く
    ["chat", "xyz789", false, "/s/xyz789"],
    // 解決後は確定した選択へ揃え、未選択は `/` へ戻す
    ["chat", "xyz789", true, "/s/xyz789"],
    ["chat", "", true, "/"],
    // URL と同じ選択でも返す (所属スペースを載せ直すため。同一 URL の置換は書き手が省く)
    ["chat", "abc123", true, "/s/abc123"],
    ["chat", "abc123", false, "/s/abc123"],
  ];
  for (const [view, selectedSessionId, entryResolved, expected] of table) {
    assert.equal(
      sessionPath(view, selectedSessionId, entryResolved),
      expected,
      `${view} selected=${selectedSessionId} resolved=${entryResolved}`,
    );
  }
  // 会話 ID は不透明な値として encode する
  assert.equal(sessionPath("chat", "a b", true), "/s/a%20b");
});

test("URL が指定する会話を返し、入口の解決状態は会話の有無から決まる", () => {
  assert.equal(sessionIdOf(CHAT_ROUTE), undefined);
  assert.equal(sessionIdOf(sessionUrl("abc123")), "abc123");
  assert.equal(sessionIdOf(settings("agents")), undefined);
  assert.equal(sessionIdOf(ACTIVITY_ROUTE), undefined);
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
  // 実行状況は全スペースを出す画面なので、`?space=` で絞らない (解釈しない)
  assert.equal(entrySpaceOf(ACTIVITY_ROUTE, "?space=demo"), null);
  // 不正な値も「不正な指定」として渡し、既定スペースへ黙って落とさない
  assert.equal(entrySpaceOf(sessionUrl("abc123"), "?space=../bad"), "../bad");
});

test("会話を指定した URL の `space` は選択中のスペースで揃え、他のクエリは書き方ごと残す", () => {
  const session = sessionUrl("abc123");
  // リンクを別の環境で開いても会話の所属で解決できるよう、会話を指定した URL は常にスペースを載せる
  assert.equal(withEntrySpace(session, "", "demo"), "?space=demo");
  assert.equal(withEntrySpace(session, "?space=old", "demo"), "?space=demo");
  assert.equal(withEntrySpace(session, "?x=1&space=old&y=2", "demo"), "?space=demo&x=1&y=2");
  // 他のクエリのパーセントエンコーディングは組み直さない
  assert.equal(withEntrySpace(session, "?x=%20b", "demo"), "?space=demo&x=%20b");
  // 解釈できないキーは落とさない (他のクエリを壊すより残す)
  assert.equal(withEntrySpace(session, "?%zz=1", "demo"), "?space=demo&%zz=1");
  // 会話を指定しない URL と設定画面はスペースを載せない (残っていれば外す)
  assert.equal(withEntrySpace(CHAT_ROUTE, "", "demo"), "");
  assert.equal(withEntrySpace(CHAT_ROUTE, "?space=demo", "demo"), "");
  assert.equal(withEntrySpace(CHAT_ROUTE, "?space=demo&x=%20", "demo"), "?x=%20");
  assert.equal(withEntrySpace(settings("files"), "?space=demo", "demo"), "");
  assert.equal(withEntrySpace(ACTIVITY_ROUTE, "?space=demo", "demo"), "");
});

/** アプリが書く会話 URL (pathname + `space`)。hooks/useRoute.ts の syncSessionPath と同じ組み方 */
function selectionHref(sessionId: string, spaceId: string): string {
  const path = sessionPath("chat", sessionId, true) ?? "";
  return `${path}${withEntrySpace(parseRoute(path), "", spaceId)}`;
}

test("確定した選択の URL を開くと、会話と所属スペースの両方が解決できる", () => {
  const href = selectionHref("a b", "space-1111111111111111");
  assert.equal(href, "/s/a%20b?space=space-1111111111111111");
  const url = new URL(href, "https://u7agent.example");
  const route = parseRoute(url.pathname);
  assert.equal(sessionIdOf(route), "a b");
  assert.equal(entrySpaceOf(route, url.search), "space-1111111111111111");
  // 既存の `space` なしリンクは、その環境の保存値で解決する (互換)
  assert.equal(sessionIdOf(parseRoute("/s/abc123")), "abc123");
  assert.equal(entrySpaceOf(parseRoute("/s/abc123"), ""), null);
});

test("会話を指定して開くリンクは所属スペースを載せ、不明なら載せない", () => {
  assert.equal(sessionEntryHref("abc123"), "/s/abc123");
  assert.equal(sessionEntryHref("a b"), "/s/a%20b");
  assert.equal(sessionEntryHref("a b", "default"), "/s/a%20b?space=default");
  assert.equal(sessionEntryHref("abc123", "space-1111111111111111"), "/s/abc123?space=space-1111111111111111");
});
