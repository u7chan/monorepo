// 共有コンテンツの公開サービス。実 Cloudflare / 実 sandbox は使わず、ZIP と HTTP client を stub して
// 検証・状態遷移・秘密値検査・復帰規則を固定する。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SharedContentRow, SharedContentStatus } from "../src/app-db";
import { CloudflareApiError, type CloudflareAsset, type CloudflareAssetsApi } from "../src/cloudflare-api";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { SandboxRequestError } from "../src/sandbox/client";
import { createZipStream, type ZipEntry } from "../src/sandbox/zip";
import {
  SHARED_CONTENT_MAX_FILE_BYTES,
  SHARED_CONTENT_NO_CREDENTIALS,
  SharedContentsService,
  resolveSharedContentSource,
  validateSharedAssetEntries,
  type SharedContentStore,
} from "../src/shared-contents";

const ROOT = "/workspace";
const SESSION_CWD = "/workspace/projects/app";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-0123456789";

class FakeStore implements SharedContentStore {
  rows = new Map<string, SharedContentRow>();
  inserts = 0;
  failInsert = false;
  failRead = false;
  failPublishedUpdate = false;
  failPublishedOnce = false;
  failAcceptanceUpdate = false;

  insertSharedContent(row: SharedContentRow): void {
    if (this.failInsert) throw new Error("db insert boom");
    this.inserts += 1;
    this.rows.set(row.id, { ...row });
  }

  updateSharedContentState(
    id: string,
    patch: {
      status: SharedContentStatus;
      updatedAt: number;
      publishedAt: number | null;
      stoppedAt: number | null;
      lastError: string | null;
    },
  ): void {
    if (this.failPublishedUpdate && patch.status === "published") throw new Error("db write boom");
    if (this.failPublishedOnce && patch.status === "published") {
      this.failPublishedOnce = false;
      throw new Error("db write boom once");
    }
    if (this.failAcceptanceUpdate && patch.status === "publishing") throw new Error("db update boom");
    const row = this.rows.get(id);
    if (!row) throw new Error("missing row");
    this.rows.set(id, { ...row, ...patch });
  }

  getSharedContent(id: string): SharedContentRow | undefined {
    if (this.failRead) throw new Error("db read boom");
    return this.rows.get(id);
  }

  listSharedContents(): SharedContentRow[] {
    if (this.failRead) throw new Error("db read boom");
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listPublishingSharedContents(): SharedContentRow[] {
    return [...this.rows.values()].filter((row) => row.status === "publishing");
  }
}

type ZipFactory = { stream: () => ReadableStream<Uint8Array>; cleanup: () => void };

function zipFactory(files: Record<string, string>, directories: string[] = []): ZipFactory {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-shared-src-"));
  const entries: ZipEntry[] = [];
  const mtime = new Date(2026, 0, 1, 0, 0, 0);
  for (const [name, content] of Object.entries(files)) {
    const source = join(dir, name.replaceAll("/", "__"));
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, content);
    entries.push({ name, source, mtime });
  }
  for (const name of directories) entries.push({ name: `${name}/`, mtime });
  return {
    stream: () => createZipStream(entries),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** 先頭のローカルヘッダ直後の deflate を 1 バイト壊す (中央ディレクトリはそのまま) */
function corruptFirstDeflate(buffer: Buffer): Buffer {
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const offset = buffer.indexOf(signature);
  assert.ok(offset >= 0, "local header not found");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const copy = Buffer.from(buffer);
  copy[dataStart + 1] ^= 0xff;
  return copy;
}

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(buffer)) as ReadableStream<Uint8Array>;
}

function workspaceFor(zip: ZipFactory, calls: { path: string; exclude: readonly string[] }[] = []) {
  const workspace = {
    downloadEntry: async (path: string, exclude: readonly string[]) => {
      calls.push({ path, exclude });
      return {
        contentType: "application/zip",
        contentDisposition: "attachment",
        body: zip.stream(),
      };
    },
    listFiles: async (path: string) => ({ path, entries: [], truncated: false }),
  } as unknown as SandboxWorkspaceClient;
  return workspace;
}

function cloudflareStub(
  overrides: Partial<CloudflareAssetsApi> & {
    published?: CloudflareAsset[][];
    configs?: { headers?: string; redirects?: string }[];
  } = {},
) {
  const published: CloudflareAsset[][] = overrides.published ?? [];
  const configs: { headers?: string; redirects?: string }[] = overrides.configs ?? [];
  let subdomainCalls = 0;
  const api: CloudflareAssetsApi = {
    getAccountSubdomain: async () => "demo",
    getScriptSubdomain: async () => {
      subdomainCalls += 1;
      return { enabled: true, previewsEnabled: false };
    },
    publishAssets: async (_script, assets, config) => {
      published.push([...assets]);
      configs.push(config ?? {});
    },
    ...overrides,
  };
  return { api, published, configs, subdomainCalls: () => subdomainCalls };
}

interface SetupOptions {
  zip?: ZipFactory;
  cloudflare?: Partial<CloudflareAssetsApi>;
  credentials?: { accountId: string; apiToken: string } | null;
  credentialError?: boolean;
  sessionCwd?: string | null;
  secretValues?: readonly string[];
  workspace?: SandboxWorkspaceClient;
}

function setup(options: SetupOptions = {}) {
  const zip = options.zip ?? zipFactory({ "index.html": "<!doctype html><title>hello</title>" });
  const store = new FakeStore();
  const downloadCalls: { path: string; exclude: readonly string[] }[] = [];
  const cloudflare = cloudflareStub(options.cloudflare);
  let counter = 0;
  let clock = 1_000;
  const service = new SharedContentsService({
    store,
    sessions: {
      workdirOfId: () => (options.sessionCwd === null ? undefined : (options.sessionCwd ?? SESSION_CWD)),
    },
    workspace: options.workspace ?? workspaceFor(zip, downloadCalls),
    credentials: {
      credential: () => {
        if (options.credentialError) throw new Error("master key unavailable");
        return options.credentials === undefined
          ? { accountId: ACCOUNT, apiToken: TOKEN }
          : options.credentials === null
            ? null
            : options.credentials;
      },
    },
    createCloudflare: () => cloudflare.api,
    rootCwd: ROOT,
    maskError: (text) => text,
    secretValues: () => options.secretValues ?? [],
    now: () => (clock += 1),
    newId: () => `id${++counter}`,
  });
  return { service, store, downloadCalls, cloudflare, zip };
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "session-1",
  directory: "dist",
  ...overrides,
});

test("作成は URL と remoteId を受付時に確定し、公開成功で published にする", async () => {
  const { service, store, downloadCalls, cloudflare, zip } = setup({
    zip: zipFactory({ "index.html": "<h1>hi</h1>", "assets/app.js": "console.log(1)" }),
  });
  try {
    const accepted = await service.create(payload());
    assert.deepEqual(accepted, { id: "id1", status: "publishing" });
    const row = store.getSharedContent("id1");
    assert.ok(row);
    assert.equal(row.sourcePath, "projects/app/dist");
    assert.equal(row.provider, "cloudflare");
    assert.equal(row.providerAccount, ACCOUNT);
    assert.equal(row.remoteId, "u7s-id1");
    assert.equal(row.publicUrl, "https://u7s-id1.demo.workers.dev/");
    assert.equal(row.status, "publishing");

    await service.waitForIdle("id1");
    const done = store.getSharedContent("id1");
    assert.equal(done?.status, "published", done?.lastError ?? "no error");
    assert.ok(done?.publishedAt);
    assert.equal(done?.lastError, null);
    assert.deepEqual(downloadCalls, [{ path: "projects/app/dist", exclude: [] }]);
    assert.equal(cloudflare.published.length, 1);
    assert.deepEqual(
      cloudflare.published[0].map((asset) => [asset.path, asset.contentType, asset.size]),
      [
        ["index.html", "text/html; charset=utf-8", 11],
        ["assets/app.js", "text/javascript; charset=utf-8", 14],
      ],
    );
    // manifest のハッシュは 32 桁の 16 進
    for (const asset of cloudflare.published[0]) assert.match(asset.hash, /^[0-9a-f]{32}$/);
  } finally {
    zip.cleanup();
  }
});

test("index.html が無ければ failed にし、Cloudflare へは送らない", async () => {
  const zip = zipFactory({ "main.html": "<h1>no index</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "failed");
    assert.match(row?.lastError ?? "", /index\.html/);
    assert.equal(cloudflare.published.length, 0);
  } finally {
    zip.cleanup();
  }
});

test("公開前の秘密値検査で止め、状態を failed にする", async () => {
  const secret = "sk-super-secret-value";
  const zip = zipFactory({ "index.html": `<script>const key = "${secret}"</script>` });
  const { service, store, cloudflare } = setup({ zip, secretValues: [secret] });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "failed");
    assert.match(row?.lastError ?? "", /秘密値/);
    assert.equal(cloudflare.published.length, 0);
  } finally {
    zip.cleanup();
  }
});

test("更新は同じ URL / remoteId を保ち、失敗しても published のまま lastError を残す", async () => {
  let calls = 0;
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store } = setup({
    zip,
    cloudflare: {
      publishAssets: async () => {
        calls += 1;
        if (calls === 2) throw new CloudflareApiError("invalid");
      },
    },
  });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const before = store.getSharedContent("id1");
    await service.publish("id1");
    await service.waitForIdle("id1");
    const after = store.getSharedContent("id1");
    assert.equal(after?.status, "published");
    assert.equal(after?.publicUrl, before?.publicUrl);
    assert.equal(after?.remoteId, before?.remoteId);
    assert.ok(after?.lastError);
  } finally {
    zip.cleanup();
  }
});

test("初回公開の失敗は failed、結果不明で subdomain が有効なら published + lastError", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const first = setup({
    zip,
    cloudflare: {
      publishAssets: async () => {
        throw new CloudflareApiError("invalid");
      },
    },
  });
  try {
    await first.service.create(payload());
    await first.service.waitForIdle("id1");
    assert.equal(first.store.getSharedContent("id1")?.status, "failed");
  } finally {
    zip.cleanup();
  }

  const timeoutZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const second = setup({
    zip: timeoutZip,
    cloudflare: {
      publishAssets: async () => {
        throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => ({ enabled: true, previewsEnabled: false }),
    },
  });
  try {
    await second.service.create(payload());
    await second.service.waitForIdle("id1");
    const row = second.store.getSharedContent("id1");
    assert.equal(row?.status, "published");
    assert.ok(row?.lastError);
  } finally {
    timeoutZip.cleanup();
  }
});

test("結果不明の照会も失敗したら publishing のまま残し、停止だけを受け付ける状態にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store } = setup({
    zip,
    cloudflare: {
      publishAssets: async () => {
        throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => {
        throw new CloudflareApiError("timeout");
      },
    },
  });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "publishing");
    assert.ok(row?.lastError);
    await assert.rejects(() => service.publish("id1"), /公開処理中/);
  } finally {
    zip.cleanup();
  }
});

test("DB 更新に失敗したら published にせず、publishing のまま残す", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store } = setup({ zip });
  store.failPublishedUpdate = true;
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    assert.equal(store.getSharedContent("id1")?.status, "publishing");
  } finally {
    zip.cleanup();
  }
});

test("資格情報が無い / セッションが無い / アカウント不一致は受付で止める", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const noCredential = setup({ zip, credentials: null });
  try {
    await assert.rejects(
      () => noCredential.service.create(payload()),
      (error: any) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.message, SHARED_CONTENT_NO_CREDENTIALS);
        return true;
      },
    );
    assert.equal(noCredential.store.inserts, 0);
  } finally {
    zip.cleanup();
  }

  const noSession = setup({ zip, sessionCwd: null });
  try {
    await assert.rejects(
      () => noSession.service.create(payload()),
      (error: any) => error.statusCode === 404,
    );
  } finally {
    zip.cleanup();
  }

  const mismatchZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const mismatch = setup({ zip: mismatchZip });
  try {
    await mismatch.service.create(payload());
    await mismatch.service.waitForIdle("id1");
    assert.equal(mismatch.store.getSharedContent("id1")?.status, "published");
    // 接続を別アカウントへ変えた service では、保存済みの providerAccount と一致しないため 409
    const other = new SharedContentsService({
      store: mismatch.store,
      sessions: { workdirOfId: () => SESSION_CWD },
      workspace: workspaceFor(mismatchZip),
      credentials: { credential: () => ({ accountId: "other", apiToken: TOKEN }) },
      createCloudflare: () => cloudflareStub().api,
      rootCwd: ROOT,
      maskError: (text) => text,
      secretValues: () => [],
    });
    await assert.rejects(
      () => other.publish("id1"),
      (error: any) => error.statusCode === 409,
    );
  } finally {
    mismatchZip.cleanup();
  }
});

test("パス解決は root 外・絶対パス・セッション外を拒否する", () => {
  assert.equal(resolveSharedContentSource(ROOT, SESSION_CWD, "dist"), "projects/app/dist");
  assert.equal(
    resolveSharedContentSource(ROOT, `${ROOT}/.u7agent/sessions/s1`, "./dist/"),
    ".u7agent/sessions/s1/dist",
  );
  for (const value of ["", ".", "..", "../secret", "/etc", "a/../../b", "a\\b"]) {
    assert.throws(
      () => resolveSharedContentSource(ROOT, SESSION_CWD, value),
      /ディレクトリ|パス|ワークスペース|セッション/,
      value,
    );
  }
  assert.throws(() => resolveSharedContentSource(ROOT, "/outside/app", "dist"));
});

test("エントリ検証は symlink・重複・個別サイズ超過を拒否する", () => {
  const file = (name: string, size = 1): any => ({
    name,
    isDirectory: false,
    compression: 0,
    flags: 0,
    crc32: 0,
    compressedSize: size,
    size,
    localHeaderOffset: 0,
    unixMode: 0o100644,
  });
  assert.deepEqual(
    validateSharedAssetEntries([file("index.html")]).map((entry) => entry.name),
    ["index.html"],
  );
  assert.throws(() => validateSharedAssetEntries([file("other.html")]), /index\.html/);
  assert.throws(() => validateSharedAssetEntries([file("index.html"), file("index.html")]), /重複/);
  assert.throws(() => validateSharedAssetEntries([file("../index.html")]), /パス/);
  assert.throws(() => validateSharedAssetEntries([file("/index.html")]), /パス/);
  assert.throws(() => validateSharedAssetEntries([{ ...file("index.html"), unixMode: 0o120777 }]), /symlink/);
  assert.throws(() => validateSharedAssetEntries([file("index.html", SHARED_CONTENT_MAX_FILE_BYTES + 1)]), /25 MiB/);
});

test("起動時の復帰は subdomain で published / stopped / failed に寄せる", async () => {
  const base = (id: string): SharedContentRow => ({
    id,
    sessionId: "session-1",
    name: id,
    sourcePath: "projects/app/dist",
    provider: "cloudflare",
    providerAccount: ACCOUNT,
    remoteId: `u7s-${id}`,
    publicUrl: `https://u7s-${id}.demo.workers.dev/`,
    status: "publishing",
    createdAt: 1,
    updatedAt: 1,
    publishedAt: null,
    stoppedAt: null,
    lastError: null,
  });
  for (const [enabled, expected] of [
    [true, "published"],
    [false, "stopped"],
  ] as const) {
    const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
    const { service, store } = setup({
      zip,
      cloudflare: { getScriptSubdomain: async () => ({ enabled, previewsEnabled: false }) },
    });
    try {
      store.insertSharedContent(base("id1"));
      await service.recoverInterrupted();
      assert.equal(store.getSharedContent("id1")?.status, expected);
    } finally {
      zip.cleanup();
    }
  }

  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const missing = setup({
    zip,
    cloudflare: {
      getScriptSubdomain: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    missing.store.insertSharedContent(base("id1"));
    await missing.service.recoverInterrupted();
    assert.equal(missing.store.getSharedContent("id1")?.status, "failed");
  } finally {
    zip.cleanup();
  }

  const checkZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const checkFailed = setup({
    zip: checkZip,
    cloudflare: {
      getScriptSubdomain: async () => {
        throw new CloudflareApiError("timeout");
      },
    },
  });
  try {
    checkFailed.store.insertSharedContent(base("id1"));
    await checkFailed.service.recoverInterrupted();
    assert.equal(checkFailed.store.getSharedContent("id1")?.status, "publishing");
    assert.ok(checkFailed.store.getSharedContent("id1")?.lastError);
  } finally {
    checkZip.cleanup();
  }
});

test("DB の保存失敗は 503 にし、202 / 200 を返さない", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store } = setup({ zip });
  try {
    store.failInsert = true;
    await assert.rejects(
      () => service.create(payload()),
      (error: any) => error.statusCode === 503,
    );
    assert.equal(store.rows.size, 0);

    store.failInsert = false;
    const accepted = await service.create(payload());
    await service.waitForIdle(accepted.id);
    assert.equal(store.getSharedContent(accepted.id)?.status, "published");
    store.failAcceptanceUpdate = true;
    await assert.rejects(
      () => service.publish(accepted.id),
      (error: any) => error.statusCode === 503,
    );
    assert.equal(store.getSharedContent(accepted.id)?.status, "published");

    store.failAcceptanceUpdate = false;
    store.failRead = true;
    assert.throws(
      () => service.get(accepted.id),
      (error: any) => error.statusCode === 503,
    );
    assert.throws(
      () => service.list(),
      (error: any) => error.statusCode === 503,
    );
  } finally {
    zip.cleanup();
  }
});

test("ZIP の件数上限を超えたら failed にし、部分公開しない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u7agent-shared-many-"));
  const index = join(dir, "index.html");
  writeFileSync(index, "<h1>hi</h1>");
  const mtime = new Date(2026, 0, 1);
  const entries: ZipEntry[] = [
    { name: "index.html", source: index, mtime },
    ...Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}.txt`, mtime })),
  ];
  const zip = { stream: () => createZipStream(entries), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  const { service, store, cloudflare } = setup({ zip });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "failed");
    assert.match(row?.lastError ?? "", /10,000/);
    assert.equal(cloudflare.published.length, 0);
  } finally {
    zip.cleanup();
  }
});

test("壊れた deflate は failed にし、BFF プロセスを落とさない", async () => {
  const zip = zipFactory({ "index.html": "a".repeat(4096) });
  const corrupt = corruptFirstDeflate(await collect(zip.stream()));
  const workspace = {
    listFiles: async (path: string) => ({ path, entries: [], truncated: false }),
    downloadEntry: async () => ({
      contentType: "application/zip",
      contentDisposition: "attachment",
      body: streamOf(corrupt),
    }),
  } as unknown as SandboxWorkspaceClient;
  const { service, store, cloudflare } = setup({ zip, workspace });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "failed");
    assert.match(row?.lastError ?? "", /読み取れません/);
    assert.equal(cloudflare.published.length, 0);
  } finally {
    zip.cleanup();
  }
});

test("同じ id の受付は直列化し、待機中の二重受付を 409 にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listCalls = 0;
  const base = workspaceFor(zip);
  const workspace = {
    ...base,
    listFiles: async (path: string) => {
      listCalls += 1;
      if (listCalls === 2) await gate;
      return { path, entries: [], truncated: false };
    },
  } as unknown as SandboxWorkspaceClient;
  const { service, store } = setup({ zip, workspace });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const first = service.publish("id1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => service.publish("id1"),
      (error: any) => error.statusCode === 409,
    );
    release();
    await first;
    await service.waitForIdle("id1");
    assert.equal(store.getSharedContent("id1")?.status, "published");
  } finally {
    zip.cleanup();
  }
});

test("資格情報の復号失敗でも起動時回収を全件続ける", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store } = setup({ zip, credentialError: true });
  const row = (id: string): SharedContentRow => ({
    id,
    sessionId: "session-1",
    name: id,
    sourcePath: "projects/app/dist",
    provider: "cloudflare",
    providerAccount: ACCOUNT,
    remoteId: `u7s-${id}`,
    publicUrl: `https://u7s-${id}.demo.workers.dev/`,
    status: "publishing",
    createdAt: 1,
    updatedAt: 1,
    publishedAt: null,
    stoppedAt: null,
    lastError: null,
  });
  try {
    store.insertSharedContent(row("id1"));
    store.insertSharedContent(row("id2"));
    await service.recoverInterrupted();
    for (const id of ["id1", "id2"]) {
      const current = store.getSharedContent(id);
      assert.equal(current?.status, "publishing");
      assert.ok(current?.lastError);
    }
  } finally {
    zip.cleanup();
  }
});

test("公開後の DB 更新に一度失敗しても published + lastError に回収する", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  store.failPublishedOnce = true;
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "published");
    assert.ok(row?.lastError);
    assert.equal(cloudflare.subdomainCalls(), 1);
  } finally {
    zip.cleanup();
  }
});

test("sandbox の SandboxRequestError.status を 400 / 409 / 413 に写す", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const notFoundWorkspace = {
    ...workspaceFor(zip),
    listFiles: async () => {
      throw new SandboxRequestError("Path not found", 404);
    },
  } as unknown as SandboxWorkspaceClient;
  const notFound = setup({ zip, workspace: notFoundWorkspace });
  try {
    await assert.rejects(
      () => notFound.service.create(payload()),
      (error: any) => error.statusCode === 400,
    );
  } finally {
    // 同じ zip を後続のテストでも使う
  }

  const tooLargeWorkspace = {
    ...workspaceFor(zip),
    downloadEntry: async () => {
      throw new SandboxRequestError("Archive is too large", 413);
    },
  } as unknown as SandboxWorkspaceClient;
  const tooLarge = setup({ zip, workspace: tooLargeWorkspace });
  try {
    await tooLarge.service.create(payload());
    await tooLarge.service.waitForIdle("id1");
    const row = tooLarge.store.getSharedContent("id1");
    assert.equal(row?.status, "failed");
    assert.match(row?.lastError ?? "", /100 MiB/);
  } finally {
    zip.cleanup();
  }

  const publishedZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const published = setup({ zip: publishedZip });
  try {
    await published.service.create(payload());
    await published.service.waitForIdle("id1");
    const publishWorkspace = {
      ...workspaceFor(publishedZip),
      listFiles: async () => {
        throw new SandboxRequestError("Path not found", 404);
      },
    } as unknown as SandboxWorkspaceClient;
    const service = new SharedContentsService({
      store: published.store,
      sessions: { workdirOfId: () => SESSION_CWD },
      workspace: publishWorkspace,
      credentials: { credential: () => ({ accountId: ACCOUNT, apiToken: TOKEN }) },
      createCloudflare: () => cloudflareStub().api,
      rootCwd: ROOT,
      maskError: (text) => text,
      secretValues: () => [],
    });
    await assert.rejects(
      () => service.publish("id1"),
      (error: any) => error.statusCode === 409,
    );
  } finally {
    publishedZip.cleanup();
  }
});

test("_headers / _redirects は config へ回し、manifest に載せない", async () => {
  const zip = zipFactory({
    "index.html": "<h1>v1</h1>",
    _headers: "X-Test: 1",
    _redirects: "/old /new 301",
    "app.js": "console.log(1)",
  });
  const { service, cloudflare, store } = setup({ zip });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    assert.equal(store.getSharedContent("id1")?.status, "published");
    assert.deepEqual(
      cloudflare.published[0].map((asset) => asset.path),
      ["index.html", "app.js"],
    );
    assert.deepEqual(cloudflare.configs[0], { headers: "X-Test: 1", redirects: "/old /new 301" });
  } finally {
    zip.cleanup();
  }
});
