import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryPage } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const { getSessionHistory, updateArchiveSettings, resetArchiveSettings, updateSessionTitle, getGitInfo } =
  await import("../src/api");

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

test("履歴 API は初回にカーソルを送らず、取得したページを返す", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const request = new Request(input);
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).pathname, "/api/sessions/session-a/history");
    assert.equal(new URL(request.url).search, "");
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
