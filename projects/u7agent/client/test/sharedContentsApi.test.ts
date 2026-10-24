// 共有コンテンツの管理 API。一覧は会話で絞らず、更新 / 再試行・停止・再公開・削除のパスと
// メソッドを固定する。失敗は BFF の固定文言（ApiError.message）と HTTP status をそのまま保つ。
import assert from "node:assert/strict";
import test from "node:test";
import type { SharedContentResponse } from "../src/types";

globalThis.location ??= { origin: "http://localhost" } as Location;
const {
  ApiError,
  deleteSharedContent,
  getAllSharedContents,
  isNotStoredError,
  publishSharedContent,
  resumeSharedContent,
  stopSharedContent,
} = await import("../src/api");

const item: SharedContentResponse = {
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  provider: "cloudflare",
  status: "published",
  publicUrl: "https://u7s-abc123.demo.workers.dev/",
  createdAt: 1,
  updatedAt: 2,
  publishedAt: 2,
  stoppedAt: null,
  lastError: null,
};

test("管理 API: 全件一覧は sessionId を付けず、更新と再試行は publish を使う", async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith("/publish") || request.url.endsWith("/resume")) {
      return Response.json({ id: item.id, status: "publishing" }, { status: 202 });
    }
    if (request.url.endsWith("/stop")) return Response.json({ id: item.id, status: "stopped" });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ items: [item] });
  });

  assert.deepEqual(await getAllSharedContents(), { items: [item] });
  assert.deepEqual(await publishSharedContent(item.id), { id: item.id, status: "publishing" });
  assert.deepEqual(await stopSharedContent(item.id), { id: item.id, status: "stopped" });
  assert.deepEqual(await resumeSharedContent(item.id), { id: item.id, status: "publishing" });
  assert.equal(await deleteSharedContent(item.id), undefined);

  assert.deepEqual(
    requests.map((request) => [request.method, new URL(request.url).pathname, new URL(request.url).search]),
    [
      ["GET", "/api/shared-contents", ""],
      ["POST", "/api/shared-contents/abc123/publish", ""],
      ["POST", "/api/shared-contents/abc123/stop", ""],
      ["POST", "/api/shared-contents/abc123/resume", ""],
      ["DELETE", "/api/shared-contents/abc123", ""],
    ],
  );
});

test("管理 API: 409 の固定文言を言い換えず、何も保存していないことを state で保つ", async (t) => {
  const busy = "公開処理中です。完了してから操作してください";
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: busy, state: "not_stored" }, { status: 409 }));
  await assert.rejects(
    () => publishSharedContent(item.id),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, busy);
      assert.equal(error.status, 409);
      assert.equal(isNotStoredError(error), true);
      return true;
    },
  );
});

test("管理 API: 一覧の取得失敗は status と文言を保つ", async (t) => {
  const readError = "共有コンテンツを読み取れません";
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: readError }, { status: 503 }));
  await assert.rejects(
    () => getAllSharedContents(),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, readError);
      assert.equal(error.status, 503);
      return true;
    },
  );
});
