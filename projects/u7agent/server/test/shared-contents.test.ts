// 共有コンテンツの公開サービス。実 Cloudflare / 実 sandbox は使わず、ZIP と HTTP client を stub して
// 検証・状態遷移・秘密値検査・復帰規則を固定する。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SharedContentRow, SharedContentStatus } from "../src/app-db";
import {
  CloudflareApiClient,
  CloudflareApiError,
  SHARED_CONTENT_NO_SUBDOMAIN,
  type CloudflareAsset,
  type CloudflareAssetsApi,
} from "../src/cloudflare-api";
import { SHARED_CONTENT_NO_CREDENTIALS } from "../src/cloudflare-settings";
import type { SandboxDownloadPlanClient, SandboxWorkspaceClient } from "../src/sandbox/client";
import { SandboxRequestError } from "../src/sandbox/client";
import type { SandboxDownloadPlan } from "../src/sandbox/protocol";
import { createZipStream, type ZipEntry } from "../src/sandbox/zip";
import {
  SHARED_CONTENT_MAX_FILE_BYTES,
  SHARED_CONTENT_PROJECT_SESSION_ROOT,
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
  failAnyUpdate = false;
  failDeleteRow = false;

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
    if (this.failAnyUpdate) throw new Error("db update boom");
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

  deleteSharedContent(id: string): void {
    if (this.failDeleteRow) throw new Error("db delete boom");
    this.rows.delete(id);
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
  const subdomains: { script: string; enabled: boolean }[] = [];
  const deleted: string[] = [];
  let subdomainCalls = 0;
  const api: CloudflareAssetsApi = {
    getAccountSubdomain: async () => "demo",
    getScriptSubdomain: async () => {
      subdomainCalls += 1;
      return { enabled: true, previewsEnabled: false };
    },
    setScriptSubdomain: async (script, enabled) => {
      subdomains.push({ script, enabled });
    },
    deleteScript: async (script) => {
      deleted.push(script);
    },
    publishAssets: async (_script, assets, config) => {
      published.push([...assets]);
      configs.push(config ?? {});
    },
    ...overrides,
  };
  return { api, published, configs, subdomains, deleted, subdomainCalls: () => subdomainCalls };
}

interface SetupOptions {
  zip?: ZipFactory;
  cloudflare?: Partial<CloudflareAssetsApi>;
  credentials?: { accountId: string; apiToken: string } | null;
  credentialError?: boolean;
  sessionCwd?: string | null;
  /** セッションがプロジェクト配下なら、その cwd (省略 = 非プロジェクト会話) */
  projectCwd?: string;
  secretValues?: readonly string[];
  workspace?: SandboxWorkspaceClient;
  planSandbox?: SandboxDownloadPlanClient | null;
  plan?: SandboxDownloadPlan | Error;
  /** 共有の除外名の実効値 (省略時は空 = 除外なし) */
  exclusions?: { effectiveNames: () => string[] };
}

function setup(options: SetupOptions = {}) {
  const zip = options.zip ?? zipFactory({ "index.html": "<!doctype html><title>hello</title>" });
  const store = new FakeStore();
  const downloadCalls: { path: string; exclude: readonly string[] }[] = [];
  const planCalls: { path: string; exclude: readonly string[]; maxFileBytes: number | undefined }[] = [];
  const cloudflare = cloudflareStub(options.cloudflare);
  let counter = 0;
  let clock = 1_000;
  const service = new SharedContentsService({
    store,
    sessions: {
      workdirOfId: () => (options.sessionCwd === null ? undefined : (options.sessionCwd ?? SESSION_CWD)),
      projectCwdOfId: () => options.projectCwd,
    },
    workspace: options.workspace ?? workspaceFor(zip, downloadCalls),
    planSandbox:
      options.planSandbox === undefined
        ? {
            planDownload: async (path, exclude, maxFileBytes) => {
              planCalls.push({ path, exclude, maxFileBytes });
              const plan = options.plan ?? defaultPreviewPlan();
              if (plan instanceof Error) throw plan;
              return plan;
            },
          }
        : options.planSandbox,
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
    exclusions: options.exclusions ?? { effectiveNames: () => [] },
    now: () => (clock += 1),
    newId: () => `id${++counter}`,
  });
  return { service, store, downloadCalls, planCalls, cloudflare, zip };
}

/** プレビューの既定の計画。index.html を含む素直なディレクトリ */
function defaultPreviewPlan(): SandboxDownloadPlan {
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
  };
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

test("公開実績のある更新の照会で script が無ければ、failed ではなく停止中として残す", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let calls = 0;
  const { service, store } = setup({
    zip,
    cloudflare: {
      publishAssets: async () => {
        calls += 1;
        if (calls === 2) throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const published = store.getSharedContent("id1");
    assert.equal(published?.status, "published");
    await service.publish("id1");
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "stopped", "一度も公開できていない場合だけ failed にする");
    assert.equal(row?.publishedAt, published?.publishedAt, "公開時刻を消さない");
    assert.match(row?.lastError ?? "", /公開物が見つかりません/);
    // 停止中の行なので、削除で後始末できる
    await service.remove("id1");
    assert.equal(store.getSharedContent("id1"), undefined);
  } finally {
    zip.cleanup();
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
    await assert.rejects(
      () => service.remove("id1"),
      (error: any) => error.statusCode === 409 && /停止してから削除/.test(error.message),
    );
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
      sessions: { workdirOfId: () => SESSION_CWD, projectCwdOfId: () => undefined },
      workspace: workspaceFor(mismatchZip),
      credentials: { credential: () => ({ accountId: "other", apiToken: TOKEN }) },
      createCloudflare: () => cloudflareStub().api,
      rootCwd: ROOT,
      maskError: (text) => text,
      secretValues: () => [],
      exclusions: { effectiveNames: () => [] },
    });
    await assert.rejects(
      () => other.publish("id1"),
      (error: any) => error.statusCode === 409,
    );
  } finally {
    mismatchZip.cleanup();
  }
});

test("workers.dev サブドメインが空なら受付を 409 で止め、行を作らない", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const empty = setup({ zip, cloudflare: { getAccountSubdomain: async () => "" } });
  try {
    await assert.rejects(
      () => empty.service.create(payload()),
      (error: any) => {
        assert.equal(error.statusCode, 409);
        // 接続確認と同じ定数を使う (文を二重に持たない)
        assert.equal(error.message, SHARED_CONTENT_NO_SUBDOMAIN);
        return true;
      },
    );
    assert.equal(empty.store.inserts, 0);
    assert.deepEqual(empty.cloudflare.published, []);
  } finally {
    zip.cleanup();
  }
});

test("パス解決は root 外・絶対パス・セッション外を拒否する", () => {
  assert.equal(resolveSharedContentSource(ROOT, SESSION_CWD, "dist"), "projects/app/dist");
  assert.equal(
    resolveSharedContentSource(ROOT, `${ROOT}/.u7agent/sessions/s1`, "./dist/"),
    ".u7agent/sessions/s1/dist",
  );
  // 字面が `.` のときだけセッションの作業フォルダ自身を指す (`.` と `./`)
  assert.equal(resolveSharedContentSource(ROOT, SESSION_CWD, "."), "projects/app");
  assert.equal(resolveSharedContentSource(ROOT, `${ROOT}/.u7agent/sessions/s1`, "./"), ".u7agent/sessions/s1");
  // 非 root の正規化は変えない (`foo/.` は従来どおり `foo`)
  assert.equal(resolveSharedContentSource(ROOT, SESSION_CWD, "foo/."), "projects/app/foo");
  for (const value of ["", "..", "../secret", "/etc", "a/../../b", "a\\b", "a/..", "./."]) {
    assert.throws(
      () => resolveSharedContentSource(ROOT, SESSION_CWD, value),
      /ディレクトリ|パス|ワークスペース|セッション/,
      value,
    );
  }
  assert.throws(() => resolveSharedContentSource(ROOT, "/outside/app", "dist"));
});

// 作業フォルダ自身 (ルート直下の index.html) の共有。公開単位はディレクトリ全量のままで、
test("`.` の作成は作業フォルダ自身を公開し、sourceKind を session-root にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>root</h1>", "assets/app.js": "console.log(1)" });
  const { service, store, downloadCalls } = setup({ zip });
  try {
    const accepted = await service.create(payload({ directory: "." }));
    await service.waitForIdle(accepted.id);
    const row = store.getSharedContent(accepted.id);
    assert.equal(row?.sourcePath, "projects/app");
    assert.equal(row?.sourceKind, "session-root");
    // 表示名の既定はディレクトリ名 (`basename`)。実際の root はセッション ID になる
    assert.equal(row?.name, "app");
    assert.deepEqual(downloadCalls, [{ path: "projects/app", exclude: [] }]);
    // DTO でも必須で返す
    assert.equal(service.list()[0].sourceKind, "session-root");

    // ``./` も同じ対象。通常のディレクトリは directory のまま
    await service.create(payload({ directory: "./" }));
    await service.waitForIdle("id2");
    const other = await service.create(payload({ directory: "dist" }));
    await service.waitForIdle(other.id);
    assert.equal(store.getSharedContent("id2")?.sourcePath, "projects/app");
    assert.equal(store.getSharedContent(other.id)?.sourceKind, "directory");
  } finally {
    zip.cleanup();
  }
});

test("`.` のプレビューは作業フォルダ自身を計画する", async () => {
  const { service, planCalls } = setup();
  const preview = await service.preview({ sessionId: "session-1", directory: "." });
  assert.equal(preview.sourcePath, "projects/app");
  assert.deepEqual(
    planCalls.map((call) => call.path),
    ["projects/app"],
  );
});

test("root 共有の更新は作業フォルダ自身を対象にできる", async () => {
  const zip = zipFactory({ "index.html": "<h1>root</h1>" });
  const { service, store, downloadCalls } = setup({ zip });
  try {
    await service.create(payload({ directory: "." }));
    await service.waitForIdle("id1");
    await service.publish("id1");
    await service.waitForIdle("id1");
    assert.equal(store.getSharedContent("id1")?.status, "published", store.getSharedContent("id1")?.lastError ?? "");
    // 等値 (作業フォルダ自身) の公開元は更新でも外れていない扱いにする
    assert.deepEqual(
      downloadCalls.map((call) => call.path),
      ["projects/app", "projects/app"],
    );
    assert.equal(store.getSharedContent("id1")?.sourceKind, "session-root");
  } finally {
    zip.cleanup();
  }
});

test("プロジェクト会話の `.` / `./` は 409 で拒否し、ディレクトリは受け付ける", async () => {
  const zip = zipFactory({ "index.html": "<h1>root</h1>" });
  const { service, store } = setup({ zip, projectCwd: SESSION_CWD });
  try {
    for (const directory of [".", "./"]) {
      await assert.rejects(
        () => service.create(payload({ directory })),
        (error: any) => {
          assert.equal(error.statusCode, 409, directory);
          assert.equal(error.message, SHARED_CONTENT_PROJECT_SESSION_ROOT, directory);
          return true;
        },
      );
      await assert.rejects(
        () => service.preview({ sessionId: "session-1", directory }),
        (error: any) => error.statusCode === 409,
        directory,
      );
    }
    assert.equal(store.inserts, 0);
    // ディレクトリの共有はセッション種別で制限しない (プロジェクト会話でも従来どおり)
    const accepted = await service.create(payload());
    await service.waitForIdle(accepted.id);
    assert.equal(store.getSharedContent(accepted.id)?.status, "published");
    assert.equal(store.getSharedContent(accepted.id)?.sourceKind, "directory");
  } finally {
    zip.cleanup();
  }
});

test("作業フォルダが空文字のセッションは、`.` でも従来どおり 404", async () => {
  const { service } = setup({ sessionCwd: "" });
  await assert.rejects(
    () => service.create(payload({ directory: "." })),
    (error: any) => error.statusCode === 404,
  );
  await assert.rejects(
    () => service.preview({ sessionId: "session-1", directory: "." }),
    (error: any) => error.statusCode === 404,
  );
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

  // 再公開の中断。公開実績がある行は 404 でも failed にせず、公開時刻を残して stopped にする
  const resumedZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const missingPublished = setup({
    zip: resumedZip,
    cloudflare: {
      getScriptSubdomain: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    missingPublished.store.insertSharedContent(base("id1"));
    missingPublished.store.updateSharedContentState("id1", {
      status: "publishing",
      updatedAt: 3,
      publishedAt: 2,
      stoppedAt: 2,
      lastError: null,
    });
    await missingPublished.service.recoverInterrupted();
    const row = missingPublished.store.getSharedContent("id1");
    assert.equal(row?.status, "stopped", "公開実績のある行を failed にしない");
    assert.equal(row?.publishedAt, 2, "公開時刻を消さない");
    assert.match(row?.lastError ?? "", /公開物が見つかりません/);
  } finally {
    resumedZip.cleanup();
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

test("sandbox の SandboxRequestError.status を 409 / 413 に写す", async () => {
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
      (error: any) => error.statusCode === 409,
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
      sessions: { workdirOfId: () => SESSION_CWD, projectCwdOfId: () => undefined },
      workspace: publishWorkspace,
      credentials: { credential: () => ({ accountId: ACCOUNT, apiToken: TOKEN }) },
      createCloudflare: () => cloudflareStub().api,
      rootCwd: ROOT,
      maskError: (text) => text,
      secretValues: () => [],
      exclusions: { effectiveNames: () => [] },
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

test("subdomain 有効化の 200 本文が壊れても、照会して published + lastError にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const path = new URL(String(input)).pathname;
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, result, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/workers/subdomain")) return ok({ subdomain: "demo" });
    if (path.endsWith("/assets-upload-session")) return ok({ jwt: "upload", buckets: [] });
    if (path.endsWith("/scripts/u7s-id1/subdomain")) {
      // 1 回目 (POST で有効化) は壊れた 200、2 回目 (照会) は有効
      return calls === 4 ? new Response("broken", { status: 200 }) : ok({ enabled: true, previews_enabled: false });
    }
    return ok({});
  };
  const service = new SharedContentsService({
    store: new FakeStore(),
    sessions: { workdirOfId: () => SESSION_CWD, projectCwdOfId: () => undefined },
    workspace: workspaceFor(zip),
    credentials: { credential: () => ({ accountId: ACCOUNT, apiToken: TOKEN }) },
    createCloudflare: (credential) =>
      new CloudflareApiClient({ accountId: credential.accountId, apiToken: credential.apiToken, fetchImpl }),
    rootCwd: ROOT,
    maskError: (text) => text,
    secretValues: () => [],
    exclusions: { effectiveNames: () => [] },
    now: () => 1_000,
    newId: () => "id1",
  });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = service.get("id1");
    assert.equal(row.status, "published");
    assert.match(row.lastError ?? "", /応答を確認できません/);
    assert.equal(calls, 5, "有効化の後に subdomain を照会する");
  } finally {
    zip.cleanup();
  }
});

test("有効化の 200 本文が壊れ、照会も壊れていたら publishing + lastError に留める", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const path = new URL(String(input)).pathname;
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, result, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/workers/subdomain")) return ok({ subdomain: "demo" });
    if (path.endsWith("/assets-upload-session")) return ok({ jwt: "upload", buckets: [] });
    if (path.endsWith("/scripts/u7s-id1/subdomain")) return new Response("broken", { status: 200 });
    return ok({});
  };
  const store = new FakeStore();
  const service = new SharedContentsService({
    store,
    sessions: { workdirOfId: () => SESSION_CWD, projectCwdOfId: () => undefined },
    workspace: workspaceFor(zip),
    credentials: { credential: () => ({ accountId: ACCOUNT, apiToken: TOKEN }) },
    createCloudflare: (credential) =>
      new CloudflareApiClient({ accountId: credential.accountId, apiToken: credential.apiToken, fetchImpl }),
    rootCwd: ROOT,
    maskError: (text) => text,
    secretValues: () => [],
    exclusions: { effectiveNames: () => [] },
    now: () => 1_000,
    newId: () => "id1",
  });
  try {
    await service.create(payload());
    await service.waitForIdle("id1");
    const row = store.getSharedContent("id1");
    assert.equal(row?.status, "publishing");
    assert.ok(row?.lastError);
  } finally {
    zip.cleanup();
  }
});

// --- 停止 / 再公開 / 削除 ---

/** 作成から published まで進める (管理操作の前提) */
async function publishNow(service: SharedContentsService, input = payload()): Promise<string> {
  const accepted = await service.create(input);
  await service.waitForIdle(accepted.id);
  assert.equal(service.get(accepted.id).status, "published");
  return accepted.id;
}

/** 状態を直接置いた行。provider を呼ばずに管理操作の入口条件だけを作る */
function rowOf(id: string, overrides: Partial<SharedContentRow> = {}): SharedContentRow {
  return {
    id,
    sessionId: "session-1",
    name: id,
    sourcePath: "projects/app/dist",
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
  };
}

test("停止は subdomain を無効にし、URL と行を残して stopped にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    const id = await publishNow(service);
    const before = store.getSharedContent(id);
    const stopped = await service.stop(id);
    assert.deepEqual(stopped, { id, status: "stopped" });
    const after = store.getSharedContent(id);
    assert.equal(after?.status, "stopped");
    assert.equal(after?.publicUrl, before?.publicUrl, "停止しても URL は変えない");
    assert.equal(after?.lastError, null);
    assert.equal(typeof after?.stoppedAt, "number");
    assert.equal(after?.publishedAt, before?.publishedAt);
    assert.deepEqual(cloudflare.subdomains, [{ script: `u7s-${id}`, enabled: false }]);
  } finally {
    zip.cleanup();
  }
});

test("停止は結果不明の publishing からだけ受け付け、それ以外の状態は 409", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    // 結果不明で publishing のまま残った行 (停止だけを受け付ける)
    store.insertSharedContent(rowOf("stuck", { status: "publishing", lastError: "結果を確認できません" }));
    assert.deepEqual(await service.stop("stuck"), { id: "stuck", status: "stopped" });

    // 公開ジョブが進行中の行 (lastError が無い publishing) は受付中なので止めない
    store.insertSharedContent(rowOf("running", { status: "publishing", lastError: null }));
    await assert.rejects(
      () => service.stop("running"),
      (error: any) => error.statusCode === 409 && /公開処理中/.test(error.message),
    );

    // 一度も公開できていない行と、既に停止した行は停止できない
    const id = await publishNow(service);
    await service.stop(id);
    await assert.rejects(
      () => service.stop(id),
      (error: any) => error.statusCode === 409,
    );
    store.insertSharedContent(rowOf("never", { status: "failed", publishedAt: null }));
    await assert.rejects(
      () => service.stop("never"),
      (error: any) => error.statusCode === 409,
    );
    await assert.rejects(
      () => service.stop("unknown"),
      (error: any) => error.statusCode === 404,
    );
    // 停止を断った行は provider を呼ばず、状態も変えない
    assert.equal(store.getSharedContent("running")?.status, "publishing");
    assert.equal(store.getSharedContent("never")?.status, "failed");
    assert.deepEqual(
      cloudflare.subdomains.map((entry) => entry.script),
      ["u7s-stuck", `u7s-${id}`],
    );
  } finally {
    zip.cleanup();
  }
});

test("停止が確定失敗なら前の状態 + lastError、結果不明は照会できたら確定・できなければ publishing に留める", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const failing = setup({
    zip,
    cloudflare: {
      setScriptSubdomain: async () => {
        throw new CloudflareApiError("invalid");
      },
    },
  });
  try {
    const id = await publishNow(failing.service);
    await assert.rejects(
      () => failing.service.stop(id),
      (error: any) => error.statusCode === 502,
    );
    const row = failing.store.getSharedContent(id);
    assert.equal(row?.status, "published", "停止できていないので公開中のまま");
    assert.ok(row?.lastError);
  } finally {
    zip.cleanup();
  }

  const timeoutZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const disabled = setup({
    zip: timeoutZip,
    cloudflare: {
      setScriptSubdomain: async () => {
        throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => ({ enabled: false, previewsEnabled: false }),
    },
  });
  try {
    const id = await publishNow(disabled.service);
    assert.deepEqual(await disabled.service.stop(id), { id, status: "stopped" });
    const row = disabled.store.getSharedContent(id);
    assert.equal(row?.status, "stopped", "照会して無効なら停止済みとして確定する");
    assert.equal(row?.lastError, null);
  } finally {
    timeoutZip.cleanup();
  }

  const unknownZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let restored = false;
  const unreachable = setup({
    zip: unknownZip,
    cloudflare: {
      setScriptSubdomain: async () => {
        if (!restored) throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => {
        if (!restored) throw new CloudflareApiError("network");
        return { enabled: false, previewsEnabled: false };
      },
    },
  });
  try {
    const id = await publishNow(unreachable.service);
    await assert.rejects(
      () => unreachable.service.stop(id),
      (error: any) => error.statusCode === 502,
    );
    const row = unreachable.store.getSharedContent(id);
    assert.equal(row?.status, "publishing", "照会できない間は状態を確定させない");
    assert.ok(row?.lastError);
    // 接続が戻れば停止で確定できる (publishing + lastError は停止を受け付ける)
    restored = true;
    assert.deepEqual(await unreachable.service.stop(id), { id, status: "stopped" });
    const settled = unreachable.store.getSharedContent(id);
    assert.equal(settled?.status, "stopped");
    assert.equal(settled?.lastError, null);
  } finally {
    unknownZip.cleanup();
  }
});

test("再公開は同じ URL と publishedAt を保って published に戻す", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    const id = await publishNow(service);
    const published = store.getSharedContent(id);
    await service.stop(id);
    const accepted = await service.resume(id);
    assert.deepEqual(accepted, { id, status: "publishing" });

    await service.waitForIdle(id);
    const resumed = store.getSharedContent(id);
    assert.equal(resumed?.status, "published");
    assert.equal(resumed?.publicUrl, published?.publicUrl, "再公開で URL を変えない");
    assert.equal(resumed?.stoppedAt, null);
    assert.equal(resumed?.lastError, null);
    assert.equal(resumed?.publishedAt, published?.publishedAt, "版は変えないので publishedAt を進めない");
    assert.deepEqual(
      cloudflare.subdomains.map((entry) => entry.enabled),
      [false, true],
    );
    assert.equal(cloudflare.published.length, 1, "再公開で成果物を送り直さない");
  } finally {
    zip.cleanup();
  }
});

test("再公開は stopped 以外を受け付けない", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    const id = await publishNow(service);
    await assert.rejects(
      () => service.resume(id),
      (error: any) => error.statusCode === 409,
    );
    store.insertSharedContent(rowOf("failed", { status: "failed", publishedAt: null }));
    await assert.rejects(
      () => service.resume("failed"),
      (error: any) => error.statusCode === 409,
    );
    store.insertSharedContent(rowOf("running", { status: "publishing" }));
    await assert.rejects(
      () => service.resume("running"),
      (error: any) => error.statusCode === 409,
    );
    await assert.rejects(
      () => service.resume("unknown"),
      (error: any) => error.statusCode === 404,
    );
    assert.deepEqual(cloudflare.subdomains, [], "断った要求では provider を呼ばない");
  } finally {
    zip.cleanup();
  }
});

test("再公開が確定失敗なら stopped + lastError、結果不明は照会できたら確定・できなければ publishing に留める", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const failing = setup({
    zip,
    cloudflare: {
      setScriptSubdomain: async (_script, enabled) => {
        if (enabled) throw new CloudflareApiError("unauthorized");
      },
    },
  });
  try {
    const id = await publishNow(failing.service);
    await failing.service.stop(id);
    await failing.service.resume(id);
    await failing.service.waitForIdle(id);
    const row = failing.store.getSharedContent(id);
    assert.equal(row?.status, "stopped", "有効化できていないので停止中のまま");
    assert.ok(row?.lastError);
  } finally {
    zip.cleanup();
  }

  const timeoutZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const enabled = setup({
    zip: timeoutZip,
    cloudflare: {
      setScriptSubdomain: async (_script, isEnabled) => {
        if (isEnabled) throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => ({ enabled: true, previewsEnabled: false }),
    },
  });
  try {
    const id = await publishNow(enabled.service);
    await enabled.service.stop(id);
    await enabled.service.resume(id);
    await enabled.service.waitForIdle(id);
    const row = enabled.store.getSharedContent(id);
    assert.equal(row?.status, "published", "照会して有効なら公開中として確定する");
    assert.equal(row?.lastError, null);
  } finally {
    timeoutZip.cleanup();
  }

  const unreachableZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let restored = false;
  const unreachable = setup({
    zip: unreachableZip,
    cloudflare: {
      setScriptSubdomain: async (_script, isEnabled) => {
        // 有効化は適用済みだが応答が timeout、照会も不達というケース
        if (isEnabled && !restored) throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => {
        if (!restored) throw new CloudflareApiError("network");
        return { enabled: true, previewsEnabled: false };
      },
    },
  });
  try {
    const id = await publishNow(unreachable.service);
    await unreachable.service.stop(id);
    await unreachable.service.resume(id);
    await unreachable.service.waitForIdle(id);
    const row = unreachable.store.getSharedContent(id);
    assert.equal(row?.status, "publishing", "照会できない間は stopped と表示しない");
    assert.ok(row?.lastError);
    // 外部は公開中のまま。接続が戻ったら停止で安全側に倒せる (stopped で拒否しない)
    restored = true;
    assert.deepEqual(await unreachable.service.stop(id), { id, status: "stopped" });
    const settled = unreachable.store.getSharedContent(id);
    assert.equal(settled?.status, "stopped");
    assert.equal(settled?.lastError, null);
  } finally {
    unreachableZip.cleanup();
  }
});

test("停止で script の不在が確定したら、公開実績に応じた終端状態へ収束させる", async () => {
  // 直接 404: 公開実績のある行は stopped + lastError にし、公開時刻を保って削除できる
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const direct = setup({
    zip,
    cloudflare: {
      setScriptSubdomain: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    const id = await publishNow(direct.service);
    const before = direct.store.getSharedContent(id);
    await assert.rejects(
      () => direct.service.stop(id),
      (error: any) => error.statusCode === 502 && /公開物が見つかりません/.test(error.message),
    );
    const row = direct.store.getSharedContent(id);
    assert.equal(row?.status, "stopped", "公開済みの行を publishing のまま残さない");
    assert.equal(row?.publishedAt, before?.publishedAt, "公開時刻を消さない");
    assert.match(row?.lastError ?? "", /削除して公開し直してください/);
    // 停止で確定したので削除できる
    await direct.service.remove(id);
    assert.equal(direct.store.getSharedContent(id), undefined);
  } finally {
    zip.cleanup();
  }

  // 未公開の行は failed に収束させ、公開の再試行へ戻す
  const freshZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const unpublished = setup({
    zip: freshZip,
    cloudflare: {
      setScriptSubdomain: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    unpublished.store.insertSharedContent(
      rowOf("id1", { status: "publishing", publishedAt: null, stoppedAt: null, lastError: "結果を確認できません" }),
    );
    await assert.rejects(
      () => unpublished.service.stop("id1"),
      (error: any) => error.statusCode === 502,
    );
    const row = unpublished.store.getSharedContent("id1");
    assert.equal(row?.status, "failed", "一度も公開できていない行だけ failed にする");
    assert.equal(row?.publishedAt, null);
    assert.match(row?.lastError ?? "", /再公開してください/);
  } finally {
    freshZip.cleanup();
  }
});

test("再公開の結果不明のあと script が消えていても、停止で終端へ収束させる", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  // 1 回目の停止は成功させ、その後「再公開の timeout + 照会不能」「script 削除済み」を再現する
  let phase: "normal" | "resume-timeout" | "deleted" = "normal";
  const { service, store } = setup({
    zip,
    cloudflare: {
      setScriptSubdomain: async (_script, enabled) => {
        if (phase === "resume-timeout" && enabled) throw new CloudflareApiError("timeout");
        if (phase === "deleted" && !enabled) throw new CloudflareApiError("timeout");
      },
      getScriptSubdomain: async () => {
        if (phase === "deleted") throw new CloudflareApiError("not_found");
        throw new CloudflareApiError("network");
      },
    },
  });
  try {
    const id = await publishNow(service);
    await service.stop(id);
    phase = "resume-timeout";
    await service.resume(id);
    await service.waitForIdle(id);
    assert.equal(store.getSharedContent(id)?.status, "publishing", "照会できない間は結果不明に留める");

    // 接続は戻ったが、script は外部で削除され、停止要求も timeout する
    phase = "deleted";
    await assert.rejects(
      () => service.stop(id),
      (error: any) => error.statusCode === 502 && /公開物が見つかりません/.test(error.message),
    );
    const row = store.getSharedContent(id);
    assert.equal(row?.status, "stopped", "通知だけの 404 でも publishing のままにしない");
    assert.match(row?.lastError ?? "", /削除して公開し直してください/);
    await service.remove(id);
    assert.equal(store.getSharedContent(id), undefined);
  } finally {
    zip.cleanup();
  }
});

test("再公開で script の不在が確定したら、停止と同じ規則で終端へ収束させる", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const direct = setup({
    zip,
    cloudflare: {
      setScriptSubdomain: async (_script, enabled) => {
        if (enabled) throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    const id = await publishNow(direct.service);
    await direct.service.stop(id);
    await direct.service.resume(id);
    await direct.service.waitForIdle(id);
    const row = direct.store.getSharedContent(id);
    assert.equal(row?.status, "stopped", "有効化の 404 で publishing のまま残さない");
    assert.match(row?.lastError ?? "", /削除して公開し直してください/);
  } finally {
    zip.cleanup();
  }

  // 未公開のまま停止した行 (publishedAt なし) は failed に収束させる
  const freshZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const unpublished = setup({
    zip: freshZip,
    cloudflare: {
      setScriptSubdomain: async (_script, enabled) => {
        if (enabled) throw new CloudflareApiError("not_found");
      },
      getScriptSubdomain: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    unpublished.store.insertSharedContent(rowOf("id1", { status: "stopped", publishedAt: null, stoppedAt: 2 }));
    await unpublished.service.resume("id1");
    await unpublished.service.waitForIdle("id1");
    const row = unpublished.store.getSharedContent("id1");
    assert.equal(row?.status, "failed", "一度も公開できていない行だけ failed にする");
    assert.equal(row?.publishedAt, null);
    assert.match(row?.lastError ?? "", /再公開してください/);
  } finally {
    freshZip.cleanup();
  }
});

test("削除は provider の削除が成功してから行を消し、404 は成功扱いにする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    const id = await publishNow(service);
    await service.remove(id);
    assert.equal(store.getSharedContent(id), undefined);
    assert.deepEqual(cloudflare.deleted, [`u7s-${id}`]);
    // 行が無いので 2 回目は 404 (provider は呼ばない)
    await assert.rejects(
      () => service.remove(id),
      (error: any) => error.statusCode === 404,
    );
  } finally {
    zip.cleanup();
  }

  const externalZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const externallyDeleted = setup({
    zip: externalZip,
    cloudflare: {
      deleteScript: async () => {
        throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    const id = await publishNow(externallyDeleted.service);
    await externallyDeleted.service.remove(id);
    assert.equal(externallyDeleted.store.getSharedContent(id), undefined, "外部で既に消えていても行を消す");
  } finally {
    externalZip.cleanup();
  }
});

test("削除の provider 失敗では行を残して 502、DB 失敗は 503 で再試行できる", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const failing = setup({
    zip,
    cloudflare: {
      deleteScript: async () => {
        throw new CloudflareApiError("transient");
      },
    },
  });
  try {
    const id = await publishNow(failing.service);
    await assert.rejects(
      () => failing.service.remove(id),
      (error: any) => error.statusCode === 502,
    );
    assert.equal(failing.store.getSharedContent(id)?.status, "published");
  } finally {
    zip.cleanup();
  }

  const dbZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let deletes = 0;
  const dbFailure = setup({
    zip: dbZip,
    // provider は 1 回目に消え、2 回目は「既に無い」を返す
    cloudflare: {
      deleteScript: async () => {
        deletes += 1;
        if (deletes > 1) throw new CloudflareApiError("not_found");
      },
    },
  });
  try {
    const id = await publishNow(dbFailure.service);
    dbFailure.store.failDeleteRow = true;
    await assert.rejects(
      () => dbFailure.service.remove(id),
      (error: any) => error.statusCode === 503,
    );
    assert.equal(dbFailure.store.getSharedContent(id)?.status, "published", "行を消せていなければ残す");
    dbFailure.store.failDeleteRow = false;
    await dbFailure.service.remove(id);
    assert.equal(dbFailure.store.getSharedContent(id), undefined);
    assert.equal(deletes, 2);
  } finally {
    dbZip.cleanup();
  }
});

test("削除は publishing の行を一律で断り、停止で確定してからだけ消せる", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip });
  try {
    store.insertSharedContent(rowOf("running", { status: "publishing", lastError: null }));
    await assert.rejects(
      () => service.remove("running"),
      (error: any) => error.statusCode === 409 && /公開処理中/.test(error.message),
    );
    assert.equal(store.getSharedContent("running")?.status, "publishing");

    // 結果不明の行も削除しない。停止で状態を確定させてから消す
    store.insertSharedContent(rowOf("stuck", { status: "publishing", lastError: "結果を確認できません" }));
    await assert.rejects(
      () => service.remove("stuck"),
      (error: any) => error.statusCode === 409 && /停止してから削除/.test(error.message),
    );
    assert.equal(store.getSharedContent("stuck")?.status, "publishing");
    assert.deepEqual(cloudflare.deleted, [], "断った削除では provider を呼ばない");

    assert.deepEqual(await service.stop("stuck"), { id: "stuck", status: "stopped" });
    await service.remove("stuck");
    assert.equal(store.getSharedContent("stuck"), undefined);
    assert.deepEqual(cloudflare.deleted, ["u7s-stuck"]);
  } finally {
    zip.cleanup();
  }
});

test("セッションが削除されても停止 / 再公開 / 削除は通り、更新だけ 409 にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { service, store, cloudflare } = setup({ zip, sessionCwd: null });
  try {
    store.insertSharedContent(rowOf("id9"));
    await assert.rejects(
      () => service.publish("id9"),
      (error: any) => error.statusCode === 409 && /セッション/.test(error.message),
    );
    assert.deepEqual(await service.stop("id9"), { id: "id9", status: "stopped" });
    await service.resume("id9");
    await service.waitForIdle("id9");
    assert.equal(store.getSharedContent("id9")?.status, "published");
    await service.remove("id9");
    assert.equal(store.getSharedContent("id9"), undefined);
    assert.deepEqual(
      cloudflare.subdomains.map((entry) => entry.enabled),
      [false, true],
    );
  } finally {
    zip.cleanup();
  }
});

test("同じ id の操作は二重に進めず、別の共有物は待たせない", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated = setup({
    zip,
    cloudflare: {
      setScriptSubdomain: async (script) => {
        // 1 つ目の停止だけを保留し、その間の別 id の操作は進められることを見る
        if (script === "u7s-id1") await gate;
      },
    },
  });
  try {
    const first = await publishNow(gated.service);
    gated.store.insertSharedContent(rowOf("id2"));
    const stopping = gated.service.stop(first);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => gated.service.stop(first),
      (error: any) => error.statusCode === 409 && /公開処理中/.test(error.message),
    );
    await assert.rejects(
      () => gated.service.remove(first),
      (error: any) => error.statusCode === 409,
    );
    // 別 id は同じ時間帯に進む (全共有物を 1 本で直列化しない)
    assert.deepEqual(await gated.service.stop("id2"), { id: "id2", status: "stopped" });
    release();
    assert.deepEqual(await stopping, { id: first, status: "stopped" });
  } finally {
    zip.cleanup();
  }
});

test("停止 / 再公開 / 削除は状態を保存できなければ成功扱いせず 503 にする", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const stopCase = setup({ zip });
  try {
    const id = await publishNow(stopCase.service);
    stopCase.store.failAnyUpdate = true;
    await assert.rejects(
      () => stopCase.service.stop(id),
      (error: any) => error.statusCode === 503,
    );
    // provider は無効化済み。状態は変えないので、再試行 (冪等) で確定できる
    assert.equal(stopCase.store.getSharedContent(id)?.status, "published");
    stopCase.store.failAnyUpdate = false;
    assert.deepEqual(await stopCase.service.stop(id), { id, status: "stopped" });
  } finally {
    zip.cleanup();
  }

  const resumeZip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const resumeCase = setup({ zip: resumeZip });
  try {
    const id = await publishNow(resumeCase.service);
    await resumeCase.service.stop(id);
    resumeCase.store.failAnyUpdate = true;
    await assert.rejects(
      () => resumeCase.service.resume(id),
      (error: any) => error.statusCode === 503,
    );
    assert.equal(resumeCase.store.getSharedContent(id)?.status, "stopped");
    resumeCase.store.failAnyUpdate = false;
    await resumeCase.service.resume(id);
    await resumeCase.service.waitForIdle(id);
    assert.equal(resumeCase.store.getSharedContent(id)?.status, "published");
  } finally {
    resumeZip.cleanup();
  }
});

test("管理操作は記録した providerAccount と現在の接続が違えば 409", async () => {
  const zip = zipFactory({ "index.html": "<h1>v1</h1>" });
  const { store, cloudflare } = setup({ zip });
  try {
    store.insertSharedContent(rowOf("id1"));
    const other = new SharedContentsService({
      store,
      sessions: { workdirOfId: () => SESSION_CWD, projectCwdOfId: () => undefined },
      workspace: workspaceFor(zip),
      credentials: { credential: () => ({ accountId: "other", apiToken: TOKEN }) },
      createCloudflare: () => cloudflare.api,
      rootCwd: ROOT,
      maskError: (text) => text,
      secretValues: () => [],
      exclusions: { effectiveNames: () => [] },
    });
    for (const operation of [() => other.stop("id1"), () => other.resume("id1"), () => other.remove("id1")]) {
      await assert.rejects(operation, (error: any) => error.statusCode === 409);
    }
    assert.deepEqual(cloudflare.subdomains, []);
    assert.deepEqual(cloudflare.deleted, []);
    assert.equal(store.getSharedContent("id1")?.status, "published");
  } finally {
    zip.cleanup();
  }
});

// プレビューは公開と同じ対象解決と計画を使い、上限超過 (413) を「走査が終わっていない」応答へ写す。
// 資格情報と provider を使わないので、未登録でも応答が返ることをここで固定する。
test("プレビューは公開と同じ 25 MiB で計画を取り、index.html 不在を problems に出す", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>" });
  const { service, planCalls } = setup({
    zip,
    credentials: null,
    plan: { ...defaultPreviewPlan(), hasIndexHtml: false, skipped: [] },
  });
  try {
    const preview = await service.preview({ sessionId: "session-1", directory: "dist" });
    assert.deepEqual(planCalls, [
      { path: "projects/app/dist", exclude: [], maxFileBytes: SHARED_CONTENT_MAX_FILE_BYTES },
    ]);
    assert.equal(preview.sourcePath, "projects/app/dist");
    assert.equal(preview.entries, 2);
    assert.equal(preview.bytes, 20);
    assert.deepEqual(preview.files, [{ name: "index.html", size: 20 }]);
    assert.equal(preview.hasIndexHtml, false);
    assert.deepEqual(preview.excludeNames, [], "未設定のスタブは除外なしを表す");
    assert.equal(preview.limited, false);
    assert.deepEqual(preview.problems, ["公開するディレクトリに index.html がありません"]);
  } finally {
    zip.cleanup();
  }
});

// 除外はプレビューと公開で同じ実効値を使う。対象ディレクトリ自身の名前は落とすので、
// `dist` を除外した状態でも `dist/` は共有できる (サンドボックスは対象名が除外名と一致すると 400)。
test("プレビューと公開は同じ除外名を渡し、対象ディレクトリ自身の名前だけを落とす", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>", "AGENTS.md": "x" });
  const names = ["AGENTS.md", ".env", "dist"];
  const { service, downloadCalls, planCalls } = setup({ zip, exclusions: { effectiveNames: () => names } });
  try {
    const preview = await service.preview({ sessionId: "session-1", directory: "dist" });
    assert.deepEqual(preview.excludeNames, ["AGENTS.md", ".env"]);
    assert.deepEqual(planCalls, [
      { path: "projects/app/dist", exclude: ["AGENTS.md", ".env"], maxFileBytes: SHARED_CONTENT_MAX_FILE_BYTES },
    ]);

    await service.create(payload());
    await service.waitForIdle("id1");
    assert.deepEqual(downloadCalls, [{ path: "projects/app/dist", exclude: ["AGENTS.md", ".env"] }]);
  } finally {
    zip.cleanup();
  }
});

test("除外名は受付時に確定してジョブへ渡し、実行中に設定が変わっても読み直さない", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>" });
  let names = ["AGENTS.md"];
  const { service, downloadCalls } = setup({ zip, exclusions: { effectiveNames: () => names } });
  try {
    await service.create(payload());
    // 受付の後に設定が変わっても、走っているジョブは受付時の一覧を使う
    names = ["dist"];
    await service.waitForIdle("id1");
    assert.deepEqual(downloadCalls, [{ path: "projects/app/dist", exclude: ["AGENTS.md"] }]);
  } finally {
    zip.cleanup();
  }
});

test("更新の受付も同じ実効値の除外名を使う", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>" });
  const { service, downloadCalls } = setup({ zip, exclusions: { effectiveNames: () => [".env", "dist"] } });
  try {
    const id = await publishNow(service);
    await service.publish(id);
    await service.waitForIdle(id);
    assert.deepEqual(downloadCalls, [
      { path: "projects/app/dist", exclude: [".env"] },
      { path: "projects/app/dist", exclude: [".env"] },
    ]);
  } finally {
    zip.cleanup();
  }
});

test("プレビューは 1 ファイルの上限を超えたパスを problems に出す", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>" });
  const { service } = setup({
    zip,
    plan: { ...defaultPreviewPlan(), oversizeFiles: ["video.mp4"], oversizeTruncated: true },
  });
  try {
    const preview = await service.preview({ sessionId: "session-1", directory: "dist" });
    assert.deepEqual(preview.oversizeFiles, ["video.mp4"]);
    assert.equal(preview.oversizeTruncated, true);
    assert.deepEqual(preview.problems, ["1 ファイルの上限（25 MiB）を超えるファイルが 1 件あります"]);
  } finally {
    zip.cleanup();
  }
});

test("プレビューの 413 は limited にして、件数・index.html の有無を判定しない", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>" });
  try {
    for (const [message, problem] of [
      ["Download has too many entries (max 10)", "公開するファイルが多すぎます（最大 10,000 件）"],
      ["Download is too large (max 10 bytes)", "公開するファイルの合計が大きすぎます（最大 100 MiB）"],
    ] as const) {
      const { service } = setup({ zip, plan: new SandboxRequestError(message, 413) });
      const preview = await service.preview({ sessionId: "session-1", directory: "dist" });
      assert.equal(preview.limited, true);
      assert.equal(preview.entries, null);
      assert.equal(preview.bytes, null);
      assert.equal(preview.hasIndexHtml, null);
      assert.deepEqual(preview.files, []);
      assert.deepEqual(preview.links, []);
      assert.deepEqual(preview.oversizeFiles, []);
      assert.deepEqual(preview.problems, [problem], "上限超過だけを problems にする");
    }
  } finally {
    zip.cleanup();
  }
});

test("プレビューの異常系はセッションなし 404 / パス不正 400 / ファイル 409 / sandbox 未設定 503", async () => {
  const zip = zipFactory({ "index.html": "<h1>hi</h1>" });
  const noSession = setup({ zip, sessionCwd: null });
  try {
    await assert.rejects(noSession.service.preview({ sessionId: "session-1", directory: "dist" }), {
      statusCode: 404,
    });
  } finally {
    zip.cleanup();
  }

  const zip2 = zipFactory({ "index.html": "<h1>hi</h1>" });
  const { service } = setup({ zip: zip2 });
  try {
    for (const directory of ["/etc", "../outside", "", "  "]) {
      await assert.rejects(service.preview({ sessionId: "session-1", directory }), (error: any) => {
        assert.equal(error.statusCode, 400, directory);
        return true;
      });
    }
  } finally {
    zip2.cleanup();
  }

  const zip3 = zipFactory({ "index.html": "<h1>hi</h1>" });
  const fileCase = setup({ zip: zip3, plan: { ...defaultPreviewPlan(), kind: "file", name: "dist" } });
  try {
    await assert.rejects(fileCase.service.preview({ sessionId: "session-1", directory: "dist" }), (error: any) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, "公開するディレクトリではありません");
      return true;
    });
  } finally {
    zip3.cleanup();
  }

  const zip4 = zipFactory({ "index.html": "<h1>hi</h1>" });
  const unavailable = setup({ zip: zip4, planSandbox: null });
  try {
    await assert.rejects(unavailable.service.preview({ sessionId: "session-1", directory: "dist" }), (error: any) => {
      assert.equal(error.statusCode, 503);
      return true;
    });
  } finally {
    zip4.cleanup();
  }
});
