// 共有コンテンツの HTTP 契約。sandbox の ZIP と Cloudflare の HTTP を stub し、
// 202 受付 → 状態 GET → published、トークン非漏洩、未登録時の拒否を検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SECRET_KEY_BYTES, SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import type { SandboxDownloadPlanClient, SandboxWorkspaceClient } from "../src/sandbox/client";
import { SandboxRequestError } from "../src/sandbox/client";
import type { SandboxDownloadPlan } from "../src/sandbox/protocol";
import { createZipStream, type ZipEntry } from "../src/sandbox/zip";
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

function workspaceFor(zip: () => ReadableStream<Uint8Array>): SandboxWorkspaceClient {
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
    downloadEntry: async () => ({
      contentType: "application/zip",
      contentDisposition: "attachment",
      body: zip(),
    }),
    checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
  } as unknown as SandboxWorkspaceClient;
}

function cloudflareFetch(calls: string[]): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    const ok = (result: unknown, status = 200) =>
      new Response(JSON.stringify({ success: true, result, errors: [], messages: [] }), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/workers/subdomain")) return ok({ subdomain: "demo" });
    if (url.pathname.endsWith("/assets-upload-session")) return ok({ jwt: "upload", buckets: [] });
    if (url.pathname.endsWith("/subdomain")) return ok({ enabled: true, previews_enabled: false });
    if (url.pathname.includes("/workers/scripts/")) return ok({});
    return ok({});
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

interface SetupOptions {
  planSandbox?: SandboxDownloadPlanClient | null;
  /** 既定の planSandbox が返す計画。Error を渡すと失敗させる */
  plan?: SandboxDownloadPlan | Error;
}

async function setup(options: SetupOptions = {}) {
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  process.env[SECRET_MASTER_KEY_ENV] = KEY;
  const dir = await mkdtemp(join(tmpdir(), "u7agent-shared-api-"));
  const calls: string[] = [];
  const planCalls: { path: string; exclude: readonly string[]; maxFileBytes: number | undefined }[] = [];
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
    workspace: workspaceFor(await makeZip(dir)),
    previewSandbox: planSandbox,
    cloudflareFetch: cloudflareFetch(calls),
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
      excludeNames: [],
      limited: false,
      problems: [],
    });
    // Phase 1 は公開と同じ「除外なし (明示空)」と 25 MiB の個別上限で計画を取る
    assert.deepEqual(planCalls, [{ path: "projects/app/dist", exclude: [], maxFileBytes: 25 * 1024 * 1024 }]);

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
