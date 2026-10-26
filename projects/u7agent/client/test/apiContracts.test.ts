import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryPage } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const {
  ApiError,
  cancelOAuthLogin,
  checkCloudflareConnection,
  deleteWebSearchApiKey,
  getTitleSummarySettings,
  getWebSearchSettings,
  isNotStoredError,
  probeCustomProvider,
  putWebSearchApiKey,
  putWebSearchProvider,
  putWebSearchSettings,
  putTitleSummarySettings,
  createSpaceApi,
  deleteSpace,
  updateArchiveSettings,
  resetArchiveSettings,
  getSharedContentExclusions,
  updateSharedContentExclusions,
  resetSharedContentExclusions,
  getGitInfo,
  getSharedContentPreview,
  statFile,
  getRuntimeDebugServeStatus,
  getRuntimeServeStatus,
  logoutOAuthProvider,
  startOAuthLogin,
  startRuntimeServe,
  stopRuntimeDebugServe,
  stopRuntimeServe,
  submitOAuthLoginCode,
} = await import("../src/api");
const { getSessionHistory, updateSessionTitle, postMessage } = createSpaceApi("default");

const page: HistoryPage = {
  sessionId: "session-a",
  items: [],
  prevCursor: null,
  hasMore: false,
  nextCursor: null,
  activeContextStartId: null,
  messageCount: 0,
  summarizedMessageCount: 0,
};

test("ランタイムのサービスAPIは会話IDなしで取得し、停止と起動には確認した世代を送る", async (t) => {
  const requests: Request[] = [];
  const result = { reachable: false, owner: null, generation: null, command: null };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(result);
  });
  assert.deepEqual(await getRuntimeServeStatus(), result);
  assert.deepEqual(await stopRuntimeServe({ generation: "gen-a" }), result);
  assert.deepEqual(await startRuntimeServe({ sessionId: "session-a", generation: "gen-a" }), result);
  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname, new URL(request.url).search]),
    [
      ["GET", "/api/serve/runtime/status", ""],
      ["POST", "/api/serve/runtime/stop", ""],
      ["POST", "/api/serve/runtime/start", ""],
    ],
  );
  assert.deepEqual(await requests[1].json(), { generation: "gen-a" });
  assert.deepEqual(await requests[2].json(), { sessionId: "session-a", generation: "gen-a" });
});

test("デバッグ用サービスのAPIは公開枠とは別のパスを使い、停止にはポートを送る", async (t) => {
  const requests: Request[] = [];
  const list = { servers: [] };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(list);
  });
  assert.deepEqual(await getRuntimeDebugServeStatus(), list);
  assert.deepEqual(await stopRuntimeDebugServe({ port: 18000 }), list);
  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["GET", "/api/serve/debug/status"],
      ["POST", "/api/serve/debug/stop"],
    ],
  );
  assert.deepEqual(await requests[1].json(), { port: 18000 });
});

test("全体停止の409は理由とHTTP statusを保つ", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "サービスの状態が変わりました" }, { status: 409 }),
  );
  await assert.rejects(stopRuntimeServe({ generation: "old" }), {
    message: "サービスの状態が変わりました",
    status: 409,
  });
});

test("変更系の503は not_stored だけを、保存されていない失敗として区別する", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "DB に接続できません", state: "not_stored" }, { status: 503 }),
  );
  const failure = await putWebSearchSettings(true).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.state, "not_stored");
  assert.equal(isNotStoredError(failure), true);
  // state を持たない 503 と、ApiError でない失敗は区別しない
  assert.equal(isNotStoredError(new ApiError("DB に接続できません", 503)), false);
  assert.equal(isNotStoredError(Object.assign(new Error("DB に接続できません"), { status: 503 })), false);
});

test("生ログは文字列化せず、原本のバイトをそのまま返す", async (t) => {
  // BOM と不正 UTF-8 を含む壊れた JSONL (調査資料の再現)。text() 経由だと BOM が消え FF が置換される
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const request = new Request(input);
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).pathname, "/api/sessions/session-a/raw");
    assert.equal(new URL(request.url).search, "?spaceId=default");
    return new Response(bytes);
  });
  const blob = await createSpaceApi("default").getSessionRawLog("session-a");
  assert.equal(blob.size, bytes.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
});

test("生ログの失敗はサーバーの理由と HTTP status を保つ", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "この会話の記録は保存されていないため、生ログは取れません。" }, { status: 404 }),
  );
  await assert.rejects(createSpaceApi("default").getSessionRawLog("missing"), {
    message: "この会話の記録は保存されていないため、生ログは取れません。",
    status: 404,
  });
});

test("履歴 API は初回にカーソルを送らず、取得したページを返す", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const request = new Request(input);
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).pathname, "/api/sessions/session-a/history");
    assert.equal(new URL(request.url).search, "?spaceId=default");
    return Response.json(page);
  });
  assert.deepEqual(await getSessionHistory("session-a"), page);
  assert.equal(fetch.mock.callCount(), 1);
});

test("履歴 API は before / limit を符号化し、null のカーソルは省略する", async (t) => {
  const queries: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    queries.push(new URL(new Request(input).url).searchParams);
    return Response.json(page);
  });
  await getSessionHistory("session-a", { before: "entry/?& 日本語", limit: 50 });
  assert.equal(queries[0].get("before"), "entry/?& 日本語");
  assert.equal(queries[0].get("limit"), "50");
  await getSessionHistory("session-a", { before: null, limit: 0 });
  assert.equal(queries[1].has("before"), false);
  assert.equal(queries[1].get("limit"), "0");
});

test("履歴 API の失敗はサーバーの理由と HTTP status を保つ", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "履歴がありません" }, { status: 404 }));
  await assert.rejects(getSessionHistory("missing"), { message: "履歴がありません", status: 404 });
});

test("スペース削除は id をパスに置く unscoped の DELETE を送り、失敗の理由と status を保つ", async (t) => {
  const requests: Request[] = [];
  let answer = () => Response.json({ ok: true });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return answer();
  });
  assert.deepEqual(await deleteSpace("space-1111111111111111"), { ok: true });
  const url = new URL(requests[0].url);
  assert.equal(requests[0].method, "DELETE");
  assert.equal(url.pathname, "/api/spaces/space-1111111111111111");
  // 削除対象はパスの id そのものなので、文脈の spaceId を付けない (listSpaces / createSpace と同じ経路)
  assert.equal(url.search, "");

  // 公開中の 409 はサーバーの文言をそのまま保ち、画面が案内として出せるようにする
  const message = "公開中のサービスがあります。設定 → ランタイムから停止してから削除してください";
  answer = () => Response.json({ error: message }, { status: 409 });
  await assert.rejects(deleteSpace("space-1111111111111111"), { message, status: 409 });
});

test("アーカイブ設定は PUT で保存し、DELETE で既定へ戻して応答を返す", async (t) => {
  const requests: Request[] = [];
  const settings = { excludeNames: ["dist"], overridden: true };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(settings);
  });
  assert.deepEqual(await updateArchiveSettings(["dist"]), settings);
  assert.deepEqual(await resetArchiveSettings(), settings);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["PUT", "DELETE"],
  );
  for (const request of requests) assert.equal(new URL(request.url).pathname, "/api/settings/archive");
  assert.deepEqual(await requests[0].json(), { excludeNames: ["dist"] });
});

// ダウンロードの除外とは別のパス・別の行であることを、パス名と本文で固定する
test("共有の除外名は専用のパスで GET / PUT / DELETE する", async (t) => {
  const requests: Request[] = [];
  const settings = {
    excludeNames: ["AGENTS.md"],
    defaultExcludeNames: ["AGENTS.md"],
    overridden: true,
    maxNames: 100,
    maxNameLength: 200,
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(settings);
  });
  assert.deepEqual(await getSharedContentExclusions(), settings);
  assert.deepEqual(await updateSharedContentExclusions(["AGENTS.md"]), settings);
  assert.deepEqual(await resetSharedContentExclusions(), settings);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET", "PUT", "DELETE"],
  );
  for (const request of requests) {
    assert.equal(new URL(request.url).pathname, "/api/settings/shared-content-exclusions");
  }
  assert.deepEqual(await requests[1].json(), { excludeNames: ["AGENTS.md"] });
  // アーカイブの設定とは別のパス (同じ画面の「ダウンロードの除外」を書き換えない)
  assert.notEqual(new URL(requests[0].url).pathname, "/api/settings/archive");
});

test("セッション名は PATCH で送り、サーバーが確定した名前を返す", async (t) => {
  const result = { sessionId: "session-a", title: "サーバーの名前" };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.method, "PATCH");
    assert.equal(new URL(request.url).pathname, "/api/sessions/session-a/title");
    assert.deepEqual(await request.json(), { title: "送信した名前" });
    return Response.json(result);
  });
  assert.deepEqual(await updateSessionTitle("session-a", "送信した名前"), result);
});

test("ピン留め API は選択スペースを付けて pinned を PATCH する", async (t) => {
  const api = createSpaceApi("space-a");
  const result = { sessionId: "session-a", pinned: true };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(request.method, "PATCH");
    assert.equal(url.pathname, "/api/sessions/session-a/pin");
    assert.equal(url.searchParams.get("spaceId"), "space-a");
    assert.deepEqual(await request.json(), { pinned: true });
    return Response.json(result);
  });
  assert.deepEqual(await api.updateSessionPinned("session-a", true), result);
});

test("引き継ぎ API は要求元のスペースを query に、移動先とエージェントとメモを body に送る", async (t) => {
  // 移動先のスペースで作った API から呼ぶと query が移動先になり、sessionSpaceGuard が 404 にする。
  // 要求元 (space-a) の API で呼び、移動先 (space-b) は body だけで渡す。
  const api = createSpaceApi("space-a");
  const result = { sessionId: "session-a", title: "サーバーの名前", spaceId: "space-b", memo: true };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(request.method, "POST");
    assert.equal(url.pathname, "/api/sessions/session-a/move");
    assert.equal(url.searchParams.get("spaceId"), "space-a");
    assert.deepEqual(await request.json(), { spaceId: "space-b", agentId: "research", memo: true });
    return Response.json(result);
  });
  assert.deepEqual(
    await api.handoffSession("session-a", { spaceId: "space-b", agentId: "research", memo: true }),
    result,
  );
});

test("引き継ぎ API の失敗はサーバーの理由と HTTP status を保つ", async (t) => {
  const api = createSpaceApi("space-a");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "実行中・キュー中・設定変更中のセッションは引き継げません" }, { status: 409 }),
  );
  await assert.rejects(api.handoffSession("session-a", { spaceId: "space-b", memo: false }), {
    message: "実行中・キュー中・設定変更中のセッションは引き継げません",
    status: 409,
  });
});

test("git 情報は root 相対の path を符号化し、repo の外の null もそのまま返す", async (t) => {
  const queries: URLSearchParams[] = [];
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(new Request(input).url);
    paths.push(url.pathname);
    queries.push(url.searchParams);
    return Response.json({ branch: url.searchParams.get("path") === "work/app" ? "feature/x" : null });
  });
  assert.deepEqual(await getGitInfo("work/app"), { branch: "feature/x" });
  assert.deepEqual(await getGitInfo(), { branch: null });
  assert.deepEqual(paths, ["/api/files/git", "/api/files/git"]);
  assert.equal(queries[0].get("path"), "work/app");
  assert.equal(queries[1].get("path"), ".", "path 省略時は root");
});

test("存在確認は root 相対の path を送り、不存在と拒否の status・文言を保つ", async (t) => {
  const requests: Request[] = [];
  let answer: () => Response = () => Response.json({ path: "work/app/a.txt" });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return answer();
  });
  assert.deepEqual(await statFile("work/app/a.txt"), { path: "work/app/a.txt" });
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/api/files/stat");
  assert.equal(url.searchParams.get("path"), "work/app/a.txt");
  // 不存在 (404) と拒否 (400) は、実在の判定を呼び出し側が分けられるように status ごと保つ
  const failures: [number, string][] = [
    [404, "Path not found: /workspace/work/app/gone.txt"],
    [400, "Not a regular file: /workspace/work/app/src"],
    [503, "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)"],
  ];
  for (const [status, message] of failures) {
    answer = () => Response.json({ error: message }, { status });
    await assert.rejects(statFile("work/app/a.txt"), { message, status });
  }
});

test("共有のプレビューは sessionId と directory を query で送り、補助なので失敗は理由と status を保つ", async (t) => {
  const requests: Request[] = [];
  const preview = {
    sourcePath: "projects/app/dist",
    entries: 2,
    bytes: 10,
    files: [{ name: "index.html", size: 10 }],
    truncated: false,
    links: [],
    linksTruncated: false,
    oversizeFiles: [],
    oversizeTruncated: false,
    hasIndexHtml: true,
    skipped: [],
    excludeNames: [],
    limited: false,
    problems: [],
  };
  let answer: () => Response = () => Response.json(preview);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return answer();
  });
  assert.deepEqual(await getSharedContentPreview({ sessionId: "session-a", directory: "dist" }), preview);
  const url = new URL(requests[0].url);
  assert.equal(requests[0].method, "GET");
  // :id より前に登録したルートなので、id ではなく固定の preview パスへ送る
  assert.equal(url.pathname, "/api/shared-contents/preview");
  assert.equal(url.searchParams.get("sessionId"), "session-a");
  assert.equal(url.searchParams.get("directory"), "dist");

  answer = () => Response.json({ error: "公開するディレクトリではありません" }, { status: 409 });
  await assert.rejects(getSharedContentPreview({ sessionId: "session-a", directory: "dist" }), {
    message: "公開するディレクトリではありません",
    status: 409,
  });
});

test("Web 検索の設定は GET / PUT / DELETE の往復で、キーは provider のパスへ送る", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      enabled: true,
      provider: "tavily",
      providers: [],
      disabledMessage: "無効です",
      state: "applied",
    });
  });
  assert.equal((await getWebSearchSettings()).enabled, true);
  assert.equal((await putWebSearchSettings(false)).state, "applied");
  assert.equal((await putWebSearchProvider("tavily")).state, "applied");
  assert.equal((await putWebSearchApiKey("tavily", "tvly-secret")).state, "applied");
  assert.equal((await deleteWebSearchApiKey("tavily")).state, "applied");
  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["GET", "/api/settings/web-search"],
      ["PUT", "/api/settings/web-search"],
      ["PUT", "/api/settings/web-search/provider"],
      ["PUT", "/api/settings/web-search/providers/tavily/key"],
      ["DELETE", "/api/settings/web-search/providers/tavily/key"],
    ],
  );
  assert.deepEqual(await requests[1].json(), { enabled: false });
  assert.deepEqual(await requests[2].json(), { provider: "tavily" });
  assert.deepEqual(await requests[3].json(), { apiKey: "tvly-secret" });
});

test("会話タイトルの設定は GET / PUT の往復で、Effort を含めてまとめて送る", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      enabled: true,
      model: "stub/stub-model",
      thinkingLevel: "high",
      effectiveThinkingLevel: "high",
      definition: "定義",
      defaultDefinition: "既定",
      models: [],
      modelAvailable: true,
    });
  });
  assert.equal((await getTitleSummarySettings()).enabled, true);
  assert.equal(
    (
      await putTitleSummarySettings({
        enabled: true,
        model: "stub/stub-model",
        thinkingLevel: "high",
        definition: "定義",
      })
    ).model,
    "stub/stub-model",
  );
  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["GET", "/api/settings/session-title"],
      ["PUT", "/api/settings/session-title"],
    ],
  );
  assert.deepEqual(await requests[1].json(), {
    enabled: true,
    model: "stub/stub-model",
    thinkingLevel: "high",
    definition: "定義",
  });
});

test("送信は定型プロンプトを結合する前の本文を titleSource として送る", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ sessionId: "session-a", status: "running", queued: false, queueDepth: 0, sendId: "s1" });
  });
  await postMessage("session-a", "固定文\n\n依頼本文", [], "依頼本文");
  await postMessage("session-a", "固定文だけ", []);
  assert.deepEqual(await requests[0]!.json(), {
    text: "固定文\n\n依頼本文",
    attachments: [],
    titleSource: "依頼本文",
  });
  // titleSource を渡さない従来形式は、送信本文だけを送る (旧クライアントと同じ本文)
  assert.deepEqual(await requests[1]!.json(), { text: "固定文だけ", attachments: [] });
});

test("OAuth サインインは provider のパスへ開始 / 送信 / 中断 / サインアウトを送る", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      runtimeAvailable: true,
      allowedModels: null,
      defaultModel: null,
      ignoredEnvironmentVariables: [],
      providers: [],
    });
  });
  await startOAuthLogin("openai");
  await submitOAuthLoginCode("openai", "http://127.0.0.1:1455/auth/callback?code=x");
  await cancelOAuthLogin("openai");
  await logoutOAuthProvider("openai");
  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["POST", "/api/settings/models/openai/login"],
      ["POST", "/api/settings/models/openai/login/code"],
      ["DELETE", "/api/settings/models/openai/login"],
      ["POST", "/api/settings/models/openai/logout"],
    ],
  );
  assert.deepEqual(await requests[1].json(), { code: "http://127.0.0.1:1455/auth/callback?code=x" });
});

test("OAuth サインインの 409 は理由と HTTP status を保つ", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "このプロバイダーはサインインが進行中です" }, { status: 409 }),
  );
  await assert.rejects(startOAuthLogin("openai"), {
    message: "このプロバイダーはサインインが進行中です",
    status: 409,
  });
});

test("Cloudflare の接続確認は POST で専用のパスを叩き、200 の結果をそのまま返す", async (t) => {
  const requests: Request[] = [];
  const result = {
    checkedAt: 1_730_000_000_000,
    accountId: "0123456789abcdef0123456789abcdef",
    subdomain: "demo",
    failure: null,
    httpStatus: null,
    message: null,
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(result);
  });
  assert.deepEqual(await checkCloudflareConnection(), result);
  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname]),
    [["POST", "/api/settings/cloudflare/check"]],
  );
});

test("カスタムプロバイダーの probe は POST で body を送り、200 の分類をそのまま返す", async (t) => {
  const requests: Request[] = [];
  const result = {
    checkedAt: 1,
    baseUrl: "http://192.0.2.10:11434/v1",
    failure: null,
    httpStatus: null,
    models: [{ id: "llama3:8b" }],
    truncated: false,
    message: null,
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(result);
  });
  assert.deepEqual(
    await probeCustomProvider({ provider: "local-llm", baseUrl: "http://192.0.2.10:11434/v1", apiKey: "" }),
    result,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "POST");
  assert.equal(new URL(requests[0]!.url).pathname, "/api/settings/custom-providers/probe");
  assert.deepEqual(await requests[0]!.json(), {
    provider: "local-llm",
    baseUrl: "http://192.0.2.10:11434/v1",
    apiKey: "",
  });
});
