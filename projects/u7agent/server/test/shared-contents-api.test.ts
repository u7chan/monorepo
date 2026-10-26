// 共有コンテンツの HTTP 契約。sandbox の ZIP と Cloudflare の HTTP を stub し、
// 202 受付 → 状態 GET → published、トークン非漏洩、未登録時の拒否を検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import type { SharedContentRow } from "../src/app-db";
import { SESSION_DIR_REL } from "../src/app-paths";
import { SECRET_KEY_BYTES, SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import type { SandboxDownloadPlanClient, SandboxWorkspaceClient } from "../src/sandbox/client";
import { SandboxRequestError } from "../src/sandbox/client";
import type { SandboxDownloadPlan } from "../src/sandbox/protocol";
import { createZipStream, type ZipEntry } from "../src/sandbox/zip";
import { DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES } from "../src/shared-content-rules";
import { SHARED_CONTENT_PROJECT_SESSION_ROOT, SHARED_CONTENT_RECONCILE_FAILED } from "../src/shared-contents";
import { asPiBff, createStubPi } from "./stub-pi";

const KEY = `1:${Buffer.alloc(SECRET_KEY_BYTES, 11).toString("base64")}`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-0123456789";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const jsonPatch = (payload: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** ZIP の元ファイルを作り、呼ばれるたびに新しいストリームを返す */
async function makeZip(dir: string): Promise<() => ReadableStream<Uint8Array>> {
  const sourceDir = join(dir, "zip-src");
  const source = join(sourceDir, "index.html");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDir, { recursive: true }));
  await writeFile(source, "<!doctype html><h1>shared</h1>");
  const entries: ZipEntry[] = [{ name: "index.html", source, mtime: new Date(2026, 0, 1) }];
  return () => createZipStream(entries);
}

function workspaceFor(
  zip: () => ReadableStream<Uint8Array>,
  downloadCalls: { path: string; exclude: readonly string[] }[] = [],
): SandboxWorkspaceClient {
  return {
    previewFile: async () => ({ text: "" }),
    statFile: async (path: string) => ({ path }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    getGitInfo: async () => ({ branch: null }),
    listSkills: async () => ({ skills: [] }),
    createDir: async (path: string) => ({ path }),
    renameEntry: async (path: string, name: string) => ({ path, name }),
    deleteFile: async () => {},
    deleteDirectory: async () => {},
    uploadFile: async ({ name }: { name: string }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
    rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
    downloadEntry: async (path: string, exclude: readonly string[]) => {
      downloadCalls.push({ path, exclude });
      return {
        contentType: "application/zip",
        contentDisposition: "attachment",
        body: zip(),
      };
    },
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  } as unknown as SandboxWorkspaceClient;
}

function cloudflareFetch(calls: string[]): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    return cloudflareResponse(url);
  };
}

function cloudflareResponse(url: URL): Response {
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, result, errors: [], messages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (url.pathname.endsWith("/workers/subdomain")) return ok({ subdomain: "demo" });
  if (url.pathname.endsWith("/assets-upload-session")) return ok({ jwt: "upload", buckets: [] });
  if (url.pathname.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
  return ok({});
}

/**
 * subdomain の切替（POST）と照会（GET）、script の削除（DELETE）だけを失敗させる。
 * 本文を持たない 4xx / 5xx を返し、client の分類（`not_found` / `unauthorized` / `transient`）をそのまま使う。
 */
function cloudflareFetchFailing(
  calls: string[],
  behavior: { set?: number; get?: number; remove?: number },
): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const status = url.pathname.endsWith("/subdomain")
      ? method === "POST"
        ? behavior.set
        : behavior.get
      : method === "DELETE"
        ? behavior.remove
        : undefined;
    if (status !== undefined) {
      return new Response("{}", { status, headers: { "content-type": "application/json" } });
    }
    return cloudflareResponse(url);
  };
}

/** プレビューの既定の計画。index.html を含む素直なディレクトリ */
function previewPlan(overrides: Partial<SandboxDownloadPlan> = {}): SandboxDownloadPlan {
  return {
    kind: "archive",
    name: "dist.zip",
    entries: 2,
    bytes: 20,
    files: [{ name: "index.html", size: 20 }],
    truncated: false,
    links: [],
    linksTruncated: false,
    oversizeFiles: [],
    oversizeTruncated: false,
    hasIndexHtml: true,
    skipped: [],
    ...overrides,
  };
}

/** 失敗の切替を持つ stub。公開を通したあとに `behavior` を書き換えて失敗を作る */
function failingCloudflare(): {
  behavior: { set?: number; get?: number; remove?: number };
  cloudflareFetch: (calls: string[]) => typeof fetch;
} {
  const behavior: { set?: number; get?: number; remove?: number } = {};
  return { behavior, cloudflareFetch: (calls) => cloudflareFetchFailing(calls, behavior) };
}

interface SetupOptions {
  planSandbox?: SandboxDownloadPlanClient | null;
  /** 既定の planSandbox が返す計画。Error を渡すと失敗させる */
  plan?: SandboxDownloadPlan | Error;
  /** Cloudflare の応答を差し替える（省略時は公開まで通る既定の stub） */
  cloudflareFetch?: (calls: string[]) => typeof fetch;
}

async function setup(options: SetupOptions = {}) {
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  process.env[SECRET_MASTER_KEY_ENV] = KEY;
  const dir = await mkdtemp(join(tmpdir(), "u7agent-shared-api-"));
  const calls: string[] = [];
  const planCalls: { path: string; exclude: readonly string[]; maxFileBytes: number | undefined }[] = [];
  const downloadCalls: { path: string; exclude: readonly string[] }[] = [];
  const pi = createStubPi();
  const planSandbox: SandboxDownloadPlanClient | null =
    options.planSandbox === undefined
      ? {
          planDownload: async (path, exclude, maxFileBytes) => {
            planCalls.push({ path, exclude, maxFileBytes });
            const plan = options.plan ?? previewPlan();
            if (plan instanceof Error) throw plan;
            return plan;
          },
        }
      : options.planSandbox;
  const bff = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: dir,
    pi: asPiBff(pi),
    workspace: workspaceFor(await makeZip(dir), downloadCalls),
    previewSandbox: planSandbox,
    cloudflareFetch: (options.cloudflareFetch ?? cloudflareFetch)(calls),
  });
  const project = await jsonBody(
    await bff.app.request("/api/projects", jsonPost({ cwd: "projects/app", name: "app" })),
  );
  const session = await jsonBody(await bff.app.request("/api/sessions", jsonPost({ projectId: project.project.id })));
  await bff.app.request("/api/settings/cloudflare", jsonPut({ accountId: ACCOUNT, apiToken: TOKEN }));
  return {
    bff,
    pi,
    sessionId: session.sessionId as string,
    downloadCalls,
    calls,
    planCalls,
    restore: async () => {
      await bff.close();
      if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
      else process.env[SECRET_MASTER_KEY_ENV] = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForSettled(bff: Awaited<ReturnType<typeof createBffApp>>, id: string): Promise<any> {
  for (let index = 0; index < 500; index += 1) {
    const body = await jsonBody(await bff.app.request(`/api/shared-contents/${id}`));
    if (body.status !== "publishing") return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("shared content did not settle");
}

/**
 * 202 のあとのジョブは lastError を書いても status を `publishing` のまま残す経路がある。
 * その経路の完了を status ではなく lastError で待つ。
 */
async function waitForLastError(bff: Awaited<ReturnType<typeof createBffApp>>, id: string): Promise<any> {
  for (let index = 0; index < 500; index += 1) {
    const body = await jsonBody(await bff.app.request(`/api/shared-contents/${id}`));
    if (body.lastError !== null) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("shared content did not record lastError");
}

/** API からは作れない状態の行を直接置く（停止の失敗経路を組み立てるための前提） */
function seedRow(
  bff: Awaited<ReturnType<typeof createBffApp>>,
  sessionId: string,
  id: string,
  overrides: Partial<SharedContentRow> = {},
): void {
  bff.appDb.insertSharedContent({
    id,
    sessionId,
    name: id,
    sourcePath: "projects/app/dist",
    sourceKind: "directory",
    provider: "cloudflare",
    providerAccount: ACCOUNT,
    remoteId: `u7s-${id}`,
    publicUrl: `https://u7s-${id}.demo.workers.dev/`,
    status: "published",
    createdAt: 1,
    updatedAt: 1,
    publishedAt: 2,
    stoppedAt: null,
    lastError: null,
    ...overrides,
  });
}

test("202 受付 → 状態 GET → published。一覧と再公開で URL を維持する", async () => {
  const { bff, pi, sessionId, calls, restore } = await setup();
  try {
    const created = await bff.app.request(
      "/api/shared-contents",
      jsonPost({ sessionId, directory: "dist", name: "デモ" }),
    );
    const accepted = await jsonBody(created);
    assert.equal(created.status, 202, JSON.stringify(accepted));
    assert.equal(accepted.status, "publishing");
    assert.match(accepted.id, /^[0-9a-z]+$/);

    const first = await waitForSettled(bff, accepted.id);
    assert.equal(first.status, "published");
    assert.equal(first.name, "デモ");
    assert.equal(first.sourcePath, "projects/app/dist");
    assert.equal(first.provider, "cloudflare");
    assert.match(first.publicUrl, new RegExp(`^https://u7s-${accepted.id}\\.demo\\.workers\\.dev/$`));
    assert.equal(JSON.stringify(first).includes(TOKEN), false);
    assert.equal(first.remoteId, undefined, "provider 固有 ID は DTO に載せない");
    assert.notEqual(pi.secretMasker.mask(TOKEN), TOKEN, "登録したトークンをマスク対象にする");

    const list = await jsonBody(await bff.app.request("/api/shared-contents"));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, accepted.id);

    const republished = await bff.app.request(`/api/shared-contents/${accepted.id}/publish`, { method: "POST" });
    assert.equal(republished.status, 202);
    const second = await waitForSettled(bff, accepted.id);
    assert.equal(second.publicUrl, first.publicUrl);
    assert.equal(second.status, "published");
    assert.ok(calls.some((line) => line.includes("/assets-upload-session")));
  } finally {
    await restore();
  }
});

test("資格情報が未登録なら 409 で受け付けず、行を作らない", async () => {
  const { bff, sessionId, restore } = await setup();
  try {
    await bff.app.request("/api/settings/cloudflare", { method: "DELETE" });
    const response = await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" }));
    assert.equal(response.status, 409);
    const body = await jsonBody(response);
    assert.equal(body.state, "not_stored");
    assert.match(body.error, /資格情報/);
    assert.deepEqual((await jsonBody(await bff.app.request("/api/shared-contents"))).items, []);
  } finally {
    await restore();
  }
});

test("一覧は sessionId で絞れる (この会話の共有物) が、指定しなければ全件を返す", async () => {
  const { bff, sessionId, restore } = await setup();
  try {
    const project = await jsonBody(
      await bff.app.request("/api/projects", jsonPost({ cwd: "projects/other", name: "other" })),
    );
    const otherSession = await jsonBody(
      await bff.app.request("/api/sessions", jsonPost({ projectId: project.project.id })),
    );
    const first = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    const second = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId: otherSession.sessionId, directory: "dist" })),
    );

    const mine = await jsonBody(await bff.app.request(`/api/shared-contents?sessionId=${sessionId}`));
    assert.deepEqual(
      mine.items.map((item: { id: string }) => item.id),
      [first.id],
    );
    const theirs = await jsonBody(await bff.app.request(`/api/shared-contents?sessionId=${otherSession.sessionId}`));
    assert.deepEqual(
      theirs.items.map((item: { id: string }) => item.id),
      [second.id],
    );
    // 絞り込みは一覧の追加であり、指定しなければ従来どおり全件を返す
    assert.equal((await jsonBody(await bff.app.request("/api/shared-contents"))).items.length, 2);
    // 空の sessionId は絞り込みなしとして扱う (client のビルド不備で全件が消えない)
    assert.equal((await jsonBody(await bff.app.request("/api/shared-contents?sessionId="))).items.length, 2);
    assert.deepEqual((await jsonBody(await bff.app.request("/api/shared-contents?sessionId=unknown"))).items, []);
  } finally {
    await restore();
  }
});

test("未知の id は 404、body 不正は 400", async () => {
  const { bff, restore } = await setup();
  try {
    assert.equal((await bff.app.request("/api/shared-contents/nope")).status, 404);
    const invalidSchema = await bff.app.request("/api/shared-contents", jsonPost({ directory: "dist" }));
    assert.equal(invalidSchema.status, 400);
    assert.equal((await jsonBody(invalidSchema)).state, "not_stored");

    const invalidJson = await bff.app.request("/api/shared-contents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await jsonBody(invalidJson)).state, "not_stored");
    assert.equal((await bff.app.request("/api/shared-contents/nope/publish", { method: "POST" })).status, 404);
  } finally {
    await restore();
  }
});

test("停止 200 → 再公開 202 → 削除 204 で URL と行のライフサイクルを閉じる", async () => {
  const { bff, sessionId, calls, restore } = await setup();
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    const before = await waitForSettled(bff, created.id);
    assert.equal(before.status, "published");

    const stoppedResponse = await bff.app.request(`/api/shared-contents/${created.id}/stop`, { method: "POST" });
    assert.equal(stoppedResponse.status, 200);
    assert.deepEqual(await jsonBody(stoppedResponse), { id: created.id, status: "stopped" });
    const stopped = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.publicUrl, before.publicUrl, "停止しても URL は変わらない");
    assert.equal(stopped.lastError, null);

    const resumedResponse = await bff.app.request(`/api/shared-contents/${created.id}/resume`, { method: "POST" });
    assert.equal(resumedResponse.status, 202);
    assert.deepEqual(await jsonBody(resumedResponse), { id: created.id, status: "publishing" });
    const resumed = await waitForSettled(bff, created.id);
    assert.equal(resumed.status, "published");
    assert.equal(resumed.publicUrl, before.publicUrl);
    assert.equal(resumed.stoppedAt, null);

    const deleted = await bff.app.request(`/api/shared-contents/${created.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.equal((await bff.app.request(`/api/shared-contents/${created.id}`)).status, 404);
    assert.deepEqual((await jsonBody(await bff.app.request("/api/shared-contents"))).items, []);
    assert.ok(
      calls.some((line) => line.startsWith("DELETE ") && line.endsWith(`/workers/scripts/u7s-${created.id}`)),
      "削除は provider の script 削除を通る",
    );
  } finally {
    await restore();
  }
});

// What: 停止が script の不在を確定したときは終端状態を保存してから 502 を返す。
// 保存済みなのに「何も保存していない」(`state: "not_stored"`) と伝えないこと。
test("停止で script の不在が確定したら 502 に終端状態を保存し、応答に state を付けない", async () => {
  const failing = failingCloudflare();
  const { bff, sessionId, restore } = await setup({ cloudflareFetch: failing.cloudflareFetch });
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    const before = await waitForSettled(bff, created.id);
    assert.equal(before.status, "published");
    failing.behavior.set = 404;

    const response = await bff.app.request(`/api/shared-contents/${created.id}/stop`, { method: "POST" });
    assert.equal(response.status, 502);
    const body = await jsonBody(response);
    assert.equal("state" in body, false, "保存した失敗に not_stored を付けない");
    assert.match(body.error, /公開物が見つかりません/);

    const after = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(after.status, "stopped", "公開実績のある行は stopped に収束する");
    assert.equal(after.lastError, body.error, "応答と同じ文言を lastError に残す");
    assert.equal(after.publishedAt, before.publishedAt, "公開時刻を消さない");
  } finally {
    await restore();
  }
});

// What: 結果不明で照会もできない停止は `publishing` + lastError を保存する。応答に
// `state: "not_stored"` を付けず、保存した状態は GET で読めること。
test("停止の結果不明で照会できないときは publishing を保存し、応答に state を付けない", async () => {
  const failing = failingCloudflare();
  const { bff, sessionId, restore } = await setup({ cloudflareFetch: failing.cloudflareFetch });
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    await waitForSettled(bff, created.id);
    failing.behavior.set = 500;
    failing.behavior.get = 500;
    const before = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));

    const response = await bff.app.request(`/api/shared-contents/${created.id}/stop`, { method: "POST" });
    assert.equal(response.status, 502);
    const body = await jsonBody(response);
    assert.equal("state" in body, false, "保存した失敗に not_stored を付けない");
    assert.equal(body.error, SHARED_CONTENT_RECONCILE_FAILED);

    const after = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(after.status, "publishing", "結果を確定させない");
    assert.equal(after.lastError, SHARED_CONTENT_RECONCILE_FAILED);
    assert.equal(after.publishedAt, before.publishedAt, "公開実績を消さない");
  } finally {
    await restore();
  }
});

// What: 確定失敗の停止は、公開中なら開始状態、未公開なら failed へ戻して保存する。
// どの分岐でも応答に `state: "not_stored"` を付けないこと。
test("停止の確定失敗は開始状態 / failed を保存し、応答に state を付けない", async () => {
  const failing = failingCloudflare();
  const { bff, sessionId, restore } = await setup({ cloudflareFetch: failing.cloudflareFetch });
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    await waitForSettled(bff, created.id);
    failing.behavior.set = 401;
    const publishedBefore = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    const published = await bff.app.request(`/api/shared-contents/${created.id}/stop`, { method: "POST" });
    assert.equal(published.status, 502);
    const publishedBody = await jsonBody(published);
    assert.equal("state" in publishedBody, false);
    const restored = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(restored.status, "published", "停止できていないので公開中へ戻す");
    assert.equal(restored.lastError, publishedBody.error);
    assert.equal(restored.publishedAt, publishedBefore.publishedAt, "公開実績を消さない");
    assert.equal(restored.stoppedAt, publishedBefore.stoppedAt, "停止していないので stoppedAt を入れない");

    // 未公開で結果不明のまま残った行 (停止だけを受け付ける) は publishing を保存し直す
    seedRow(bff, sessionId, "stuck", { status: "publishing", publishedAt: null, lastError: "結果を確認できません" });
    const stuckBefore = await jsonBody(await bff.app.request("/api/shared-contents/stuck"));
    const unknownResponse = await bff.app.request("/api/shared-contents/stuck/stop", { method: "POST" });
    assert.equal(unknownResponse.status, 502);
    const unknownBody = await jsonBody(unknownResponse);
    assert.equal("state" in unknownBody, false, "保存した失敗に not_stored を付けない");
    const stuck = await jsonBody(await bff.app.request("/api/shared-contents/stuck"));
    assert.equal(stuck.status, "publishing");
    assert.equal(stuck.lastError, unknownBody.error);
    assert.notEqual(stuck.lastError, stuckBefore.lastError, "応答の文言を行へ保存する");
    assert.equal(stuck.publishedAt, null, "公開実績を捏造しない");

    // 公開実績の無い published は failed に収束させ、deployment の無い URL を公開中扱いにしない
    seedRow(bff, sessionId, "legacy", { status: "published", publishedAt: null });
    const legacyResponse = await bff.app.request("/api/shared-contents/legacy/stop", { method: "POST" });
    assert.equal(legacyResponse.status, 502);
    assert.equal("state" in (await jsonBody(legacyResponse)), false);
    const legacy = await jsonBody(await bff.app.request("/api/shared-contents/legacy"));
    assert.equal(legacy.status, "failed");
    assert.equal(legacy.publishedAt, null);
    assert.ok(legacy.lastError);
  } finally {
    await restore();
  }
});

// What: 202 で受け付けたあとの失敗は応答でなくジョブが状態を書く。202 応答は `state` を持たず、
// 照会できない再公開は `publishing` + lastError を保存すること。
test("再公開の 202 後に照会できなければ publishing を保存し、202 応答は state を持たない", async () => {
  const failing = failingCloudflare();
  const { bff, sessionId, restore } = await setup({ cloudflareFetch: failing.cloudflareFetch });
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    await waitForSettled(bff, created.id);
    await bff.app.request(`/api/shared-contents/${created.id}/stop`, { method: "POST" });
    failing.behavior.set = 500;
    failing.behavior.get = 500;

    const resumed = await bff.app.request(`/api/shared-contents/${created.id}/resume`, { method: "POST" });
    assert.equal(resumed.status, 202);
    assert.equal("state" in (await jsonBody(resumed)), false, "202 の応答に not_stored を付けない");
    const after = await waitForLastError(bff, created.id);
    assert.equal(after.status, "publishing", "照会できるまで状態を確定しない");
    assert.equal(after.lastError, SHARED_CONTENT_RECONCILE_FAILED);
  } finally {
    await restore();
  }
});

// What: 何も保存しない失敗 (遷移の 409、削除の 502、DB 障害の 503) は従来どおり
// `state: "not_stored"` を付け、行も変えないこと。
test("何も保存しない失敗は state: not_stored のまま行を変えない", async () => {
  const failing = failingCloudflare();
  const target = await setup({ cloudflareFetch: failing.cloudflareFetch });
  try {
    const created = await jsonBody(
      await target.bff.app.request(
        "/api/shared-contents",
        jsonPost({ sessionId: target.sessionId, directory: "dist" }),
      ),
    );
    const before = await waitForSettled(target.bff, created.id);
    failing.behavior.remove = 500;
    const removed = await target.bff.app.request(`/api/shared-contents/${created.id}`, { method: "DELETE" });
    assert.equal(removed.status, 502);
    assert.equal((await jsonBody(removed)).state, "not_stored", "provider の削除失敗では行を消していない");
    const after = await jsonBody(await target.bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(after.status, before.status);

    // 進行中の publishing は更新を受け付けない (何も変えない)
    seedRow(target.bff, target.sessionId, "running", { status: "publishing", lastError: null });
    const busy = await target.bff.app.request("/api/shared-contents/running/publish", { method: "POST" });
    assert.equal(busy.status, 409);
    assert.equal((await jsonBody(busy)).state, "not_stored");
    const running = await jsonBody(await target.bff.app.request("/api/shared-contents/running"));
    assert.equal(running.status, "publishing");
  } finally {
    await target.restore();
  }

  // 状態を保存できない 503 は、行が変わっていないので not_stored のまま
  const unsaved = await setup();
  try {
    const created = await jsonBody(
      await unsaved.bff.app.request(
        "/api/shared-contents",
        jsonPost({ sessionId: unsaved.sessionId, directory: "dist" }),
      ),
    );
    await waitForSettled(unsaved.bff, created.id);
    const before = await jsonBody(await unsaved.bff.app.request(`/api/shared-contents/${created.id}`));
    // provider の無効化は通るが、行の更新だけが失敗する状況を作る
    unsaved.bff.appDb.updateSharedContentState = () => {
      throw new Error("write failed");
    };
    const response = await unsaved.bff.app.request(`/api/shared-contents/${created.id}/stop`, { method: "POST" });
    assert.equal(response.status, 503);
    assert.equal((await jsonBody(response)).state, "not_stored");
    const after = await jsonBody(await unsaved.bff.app.request(`/api/shared-contents/${created.id}`));
    assert.deepEqual(after, before, "保存できていないので行は操作前のまま");
  } finally {
    await unsaved.restore();
  }
});

// What: 一覧・詳細・プレビュー (GET) は読み取りで何も保存しないので、失敗応答に
// `state` を付けないこと。
test("一覧・詳細・プレビューの失敗応答に state を付けない", async () => {
  const { bff, restore } = await setup();
  try {
    const detail = await bff.app.request("/api/shared-contents/nope");
    assert.equal(detail.status, 404);
    assert.deepEqual(await jsonBody(detail), { error: "Shared content not found" });

    const preview = await bff.app.request("/api/shared-contents/preview?sessionId=unknown&directory=dist");
    assert.equal(preview.status, 404);
    assert.deepEqual(await jsonBody(preview), { error: "Session not found" });
  } finally {
    await restore();
  }
});

test("停止 / 再公開 / 削除は存在しない id を 404、遷移できない状態を 409 にする", async () => {
  const { bff, restore } = await setup();
  try {
    assert.equal((await bff.app.request("/api/shared-contents/nope/stop", { method: "POST" })).status, 404);
    assert.equal((await bff.app.request("/api/shared-contents/nope/resume", { method: "POST" })).status, 404);
    assert.equal((await bff.app.request("/api/shared-contents/nope", { method: "DELETE" })).status, 404);
    for (const response of [
      await bff.app.request("/api/shared-contents/nope/stop", { method: "POST" }),
      await bff.app.request("/api/shared-contents/nope/resume", { method: "POST" }),
      await bff.app.request("/api/shared-contents/nope", { method: "DELETE" }),
    ]) {
      const body = await jsonBody(response);
      assert.equal(body.state, "not_stored");
    }
  } finally {
    await restore();
  }
});

// プレビューは `GET /api/shared-contents/:id` より前に登録した専用ルートで、id="preview" として扱わせない。
// 資格情報を使わないので、接続未登録でも見えることをここで固定する。
test("preview は :id と衝突せず、資格情報なしでも公開前の一覧を返す", async () => {
  const { bff, sessionId, planCalls, restore } = await setup();
  try {
    await bff.app.request("/api/settings/cloudflare", { method: "DELETE" });
    const response = await bff.app.request(`/api/shared-contents/preview?sessionId=${sessionId}&directory=dist`);
    const body = await jsonBody(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, {
      sourcePath: "projects/app/dist",
      entries: 2,
      bytes: 20,
      files: [{ name: "index.html", size: 20 }],
      truncated: false,
      links: [],
      linksTruncated: false,
      oversizeFiles: [],
      oversizeTruncated: false,
      hasIndexHtml: true,
      skipped: [],
      excludeNames: [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES],
      limited: false,
      problems: [],
    });
    // 公開と同じ共有の除外名と 25 MiB の個別上限で計画を取る
    assert.deepEqual(planCalls, [
      {
        path: "projects/app/dist",
        exclude: [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES],
        maxFileBytes: 25 * 1024 * 1024,
      },
    ]);

    // 同じ URL の detail は従来どおり id として 404 (preview が id を食っていない)
    assert.equal((await bff.app.request("/api/shared-contents/preview")).status, 404);
  } finally {
    await restore();
  }
});

test("preview は index.html 不在と 1 ファイル超過を problems にし、問題なしと言い切らない", async () => {
  const { bff, sessionId, restore } = await setup({
    plan: previewPlan({ hasIndexHtml: false, oversizeFiles: ["video.mp4"] }),
  });
  try {
    const body = await jsonBody(
      await bff.app.request(`/api/shared-contents/preview?sessionId=${sessionId}&directory=dist`),
    );
    assert.equal(body.limited, false);
    assert.equal(body.hasIndexHtml, false);
    assert.deepEqual(body.oversizeFiles, ["video.mp4"]);
    assert.deepEqual(body.problems, [
      "公開するディレクトリに index.html がありません",
      "1 ファイルの上限（25 MiB）を超えるファイルが 1 件あります",
    ]);
  } finally {
    await restore();
  }
});

test("preview の 413 は limited に写し、一覧と index.html の不在を出さない", async () => {
  for (const [message, problem] of [
    ["Download has too many entries (max 10000)", "公開するファイルが多すぎます（最大 10,000 件）"],
    ["Download is too large (max 104857600 bytes)", "公開するファイルの合計が大きすぎます（最大 100 MiB）"],
  ] as const) {
    const { bff, sessionId, restore } = await setup({ plan: new SandboxRequestError(message, 413) });
    try {
      const body = await jsonBody(
        await bff.app.request(`/api/shared-contents/preview?sessionId=${sessionId}&directory=dist`),
      );
      assert.equal(body.limited, true);
      assert.equal(body.entries, null);
      assert.equal(body.bytes, null);
      assert.equal(body.hasIndexHtml, null);
      assert.deepEqual(body.files, []);
      assert.deepEqual(body.problems, [problem]);
    } finally {
      await restore();
    }
  }
});

test("preview の異常系はセッションなし 404 / パス不正 400 / ファイル 409 / sandbox 未設定 503", async () => {
  const { bff, sessionId, restore } = await setup({ plan: previewPlan({ kind: "file", name: "dist" }) });
  try {
    assert.equal((await bff.app.request("/api/shared-contents/preview?sessionId=unknown&directory=dist")).status, 404);
    for (const directory of ["/etc", "../outside", "  "]) {
      const response = await bff.app.request(
        `/api/shared-contents/preview?sessionId=${sessionId}&directory=${encodeURIComponent(directory)}`,
      );
      assert.equal(response.status, 400, directory);
    }
    const file = await bff.app.request(`/api/shared-contents/preview?sessionId=${sessionId}&directory=dist`);
    assert.equal(file.status, 409);
    assert.equal((await jsonBody(file)).error, "公開するディレクトリではありません");
    // 作業フォルダ自身の共有は non-project 会話だけ (この session はプロジェクト配下)
    const root = await bff.app.request(
      `/api/shared-contents/preview?sessionId=${sessionId}&directory=${encodeURIComponent(".")}`,
    );
    assert.equal(root.status, 409);
    assert.equal((await jsonBody(root)).error, SHARED_CONTENT_PROJECT_SESSION_ROOT);
  } finally {
    await restore();
  }

  const unavailable = await setup({ planSandbox: null });
  try {
    const response = await unavailable.bff.app.request(
      `/api/shared-contents/preview?sessionId=${unavailable.sessionId}&directory=dist`,
    );
    assert.equal(response.status, 503);
  } finally {
    await unavailable.restore();
  }
});

// 作業フォルダ自身の公開は非プロジェクト会話だけ。公開元はセッションの作業フォルダで、sourceKind で区別する。
test("`.` はプロジェクト会話で 409、非プロジェクト会話で作業フォルダ自身を公開し sourceKind を返す", async () => {
  const { bff, sessionId, restore } = await setup();
  try {
    const rejected = await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "." }));
    assert.equal(rejected.status, 409);
    assert.equal((await jsonBody(rejected)).error, SHARED_CONTENT_PROJECT_SESSION_ROOT);
    assert.deepEqual((await jsonBody(await bff.app.request("/api/shared-contents"))).items, []);

    const scratch = await jsonBody(await bff.app.request("/api/sessions", jsonPost({})));
    const scratchId = scratch.sessionId as string;
    const root = `${SESSION_DIR_REL}/${scratchId}`;
    const preview = await jsonBody(
      await bff.app.request(
        `/api/shared-contents/preview?sessionId=${scratchId}&directory=${encodeURIComponent("./")}`,
      ),
    );
    assert.equal(preview.sourcePath, root);

    // 表示名は入力できる。空欄ならサーバーが basename (root ではセッション ID) へ落とす
    const accepted = await jsonBody(
      await bff.app.request(
        "/api/shared-contents",
        jsonPost({ sessionId: scratchId, directory: ".", name: "ルートの成果物" }),
      ),
    );
    const published = await waitForSettled(bff, accepted.id);
    assert.equal(published.status, "published", published.lastError ?? "");
    assert.equal(published.sourcePath, root);
    assert.equal(published.sourceKind, "session-root");
    assert.equal(published.name, "ルートの成果物");

    const unnamed = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId: scratchId, directory: "." })),
    );
    const fallback = await waitForSettled(bff, unnamed.id);
    assert.equal(fallback.name, scratchId, "空欄の表示名はセッション ID (basename) になる");

    // ディレクトリの共有は従来どおり directory
    const directory = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    assert.equal((await waitForSettled(bff, directory.id)).sourceKind, "directory");
  } finally {
    await restore();
  }
});

// 共有の除外名はアーカイブ設定とは別の行・別の既定を持ち、プレビューと公開の両方へ同じ実効値で効く。
// 対象ディレクトリ自身の名前は落とすので、`dist` を除外した状態でも `dist/` を共有できる。
test("共有の除外名は設定 API で保存し、プレビューと公開の両方へ効く", async () => {
  const { bff, sessionId, planCalls, downloadCalls, restore } = await setup();
  try {
    const saved = await jsonBody(
      await bff.app.request(
        "/api/settings/shared-content-exclusions",
        jsonPut({ excludeNames: ["AGENTS.md", "dist", ".env"] }),
      ),
    );
    assert.deepEqual(saved.excludeNames, ["AGENTS.md", "dist", ".env"]);
    assert.equal(saved.overridden, true);
    // アーカイブ設定 (ダウンロードの除外) は別の行なので変わらない
    const archive = await jsonBody(await bff.app.request("/api/settings/archive"));
    assert.equal(archive.overridden, false);

    const preview = await jsonBody(
      await bff.app.request(`/api/shared-contents/preview?sessionId=${sessionId}&directory=dist`),
    );
    assert.deepEqual(preview.excludeNames, ["AGENTS.md", ".env"], "対象ディレクトリ自身の名前は落とす");
    assert.deepEqual(planCalls.at(-1)?.exclude, ["AGENTS.md", ".env"]);

    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    await waitForSettled(bff, created.id);
    assert.deepEqual(downloadCalls.at(-1), { path: "projects/app/dist", exclude: ["AGENTS.md", ".env"] });
  } finally {
    await restore();
  }
});

test("表示名の変更: 公開中でも受け付け、URL・状態・時刻を変えずに名前だけを差し替える", async () => {
  const { bff, sessionId, restore } = await setup();
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist", name: "最初の名前" })),
    );
    // 公開ジョブと重なっても、書き込む列が違うので 409 にしない
    const duringPublish = await bff.app.request(
      `/api/shared-contents/${created.id}`,
      jsonPatch({ name: "  公開中の名前  " }),
    );
    assert.equal(duringPublish.status, 200);
    const renamedWhilePublishing = await jsonBody(duringPublish);
    assert.equal(renamedWhilePublishing.name, "公開中の名前", "前後の空白は落とす");
    assert.equal(renamedWhilePublishing.status, "publishing");

    const settled = await waitForSettled(bff, created.id);
    assert.equal(settled.status, "published");
    assert.equal(settled.name, "公開中の名前", "公開の完了で名前が戻らない");

    const renamed = await jsonBody(
      await bff.app.request(`/api/shared-contents/${created.id}`, jsonPatch({ name: "あとから変えた名前" })),
    );
    assert.equal(renamed.name, "あとから変えた名前");
    assert.equal(renamed.publicUrl, settled.publicUrl, "URL は変えない");
    assert.equal(renamed.publishedAt, settled.publishedAt, "公開の実績を変えない");
    assert.equal(renamed.updatedAt, settled.updatedAt, "一覧の並びと「更新」の時刻を変えない");
    assert.equal(renamed.status, "published");

    const detail = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(detail.name, "あとから変えた名前", "GET でも変わっている");
  } finally {
    await restore();
  }
});

test("表示名の変更の検証: 空・空白だけ・長すぎる名前と不正な本文は 400、存在しない id は 404", async () => {
  const { bff, sessionId, restore } = await setup();
  try {
    const created = await jsonBody(
      await bff.app.request("/api/shared-contents", jsonPost({ sessionId, directory: "dist" })),
    );
    const rename = (payload: unknown) => bff.app.request(`/api/shared-contents/${created.id}`, jsonPatch(payload));

    for (const payload of [{ name: "" }, { name: "   " }, { name: "a".repeat(101) }]) {
      const response = await rename(payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
      const body = await jsonBody(response);
      assert.equal(body.state, "not_stored", "保存していない失敗には state を付ける");
      assert.equal(typeof body.error, "string");
    }

    const broken = await bff.app.request(`/api/shared-contents/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(broken.status, 400);
    assert.equal((await jsonBody(broken)).state, "not_stored");

    const missing = await bff.app.request("/api/shared-contents/nope", jsonPatch({ name: "x" }));
    assert.equal(missing.status, 404);

    // 拒否した要求で名前が変わっていない
    const detail = await jsonBody(await bff.app.request(`/api/shared-contents/${created.id}`));
    assert.equal(detail.name, "dist");
  } finally {
    await restore();
  }
});
