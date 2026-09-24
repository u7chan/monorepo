// GET /api/files/download と /api/files/download/check。サンドボックスはスタブを注入し、listen せず app.request() で検証する。
// 本文は JSON に載せずストリーム中継し、`Content-Disposition`（日本語名）はそのまま通す。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../src/sandbox/client";
import type { SandboxDownloadCheck } from "../src/sandbox/protocol";

const CHECK: SandboxDownloadCheck = {
  kind: "archive",
  name: "src.zip",
  bytes: 9,
  entries: 2,
  skipped: ["node_modules"],
};

/** download / check だけ差し替えられるスタブ。他のメソッドはこのテストでは使わない */
function stubWorkspace(overrides: Partial<SandboxWorkspaceClient> = {}): {
  workspace: SandboxWorkspaceClient;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    workspace: {
      previewFile: async () => ({ text: "" }),
      listFiles: async () => ({ path: ".", entries: [], truncated: false }),
      listSkills: async () => ({ skills: [] }),
      createDir: async (path: string) => ({ path }),
      renameEntry: async (path: string, name: string) => ({ path, name }),
      deleteFile: async () => {},
      deleteDirectory: async () => {},
      uploadFile: async ({ name }) => ({ path: name, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
      downloadEntry: async (path: string) => {
        paths.push(path);
        return {
          contentType: "application/zip",
          contentDisposition: "attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.zip",
          body: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]).stream(),
        };
      },
      checkDownload: async (path: string) => {
        paths.push(path);
        return CHECK;
      },
      ...overrides,
    },
  };
}

test("GET /api/files/download streams the sandbox body and relays headers", async () => {
  const { workspace, paths } = stubWorkspace();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/download?path=src");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    // 日本語名のエンコードはサンドボックスが決め、BFF は書き換えない
    assert.equal(
      response.headers.get("Content-Disposition"),
      "attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.zip",
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    // zip は長さが確定しないため Content-Length を付けない
    assert.equal(response.headers.get("Content-Length"), null);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
    assert.deepEqual(paths, ["src"]);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/download relays a file response with its length", async () => {
  const { workspace } = stubWorkspace({
    downloadEntry: async () => ({
      contentType: "application/octet-stream",
      contentDisposition: "attachment; filename*=UTF-8''report.txt",
      contentLength: 3,
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
    }),
  });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/download?path=report.txt");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(response.headers.get("Content-Length"), "3");
    assert.equal(response.headers.get("Content-Disposition"), "attachment; filename*=UTF-8''report.txt");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/download maps sandbox failures and the missing body", async () => {
  const cases: Array<[number, number, Error | null]> = [
    [400, 400, new SandboxRequestError("Directory is excluded from archives: node_modules", 400)],
    [404, 404, new SandboxRequestError("Path not found: /workspace/nope", 404)],
    [413, 413, new SandboxRequestError("Download is too large (max 104857600 bytes)", 413)],
    [502, 502, new SandboxRequestError("サンドボックス (http://sandbox) に接続できません", 502)],
  ];
  for (const [expected, , error] of cases) {
    const { workspace } = stubWorkspace({
      downloadEntry: async () => {
        throw error as Error;
      },
    });
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
    try {
      const response = await bff.app.request("/api/files/download?path=src");
      assert.equal(response.status, expected, String(error?.message));
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, error?.message, String(error?.message));
    } finally {
      await bff.close();
    }
  }

  const { workspace } = stubWorkspace({
    downloadEntry: async () => ({ contentType: "application/zip", contentDisposition: "attachment", body: null }),
  });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/download?path=src");
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "サンドボックスが本文を返しませんでした" });
  } finally {
    await bff.close();
  }
});

test("GET /api/files/download answers 503 when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    for (const url of ["/api/files/download?path=src", "/api/files/download/check?path=src"]) {
      const response = await bff.app.request(url);
      assert.equal(response.status, 503, url);
    }
  } finally {
    await bff.close();
  }
});

test("GET /api/files/download/check relays the estimate and validates the response", async () => {
  const { workspace, paths } = stubWorkspace();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/download/check?path=src%2Fnested");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), CHECK);
    assert.deepEqual(paths, ["src/nested"]);

    // 契約外の応答（件数が負・kind が未知など）は 502 に寄せる
    workspace.checkDownload = async () => ({ ...CHECK, entries: -1 });
    assert.equal((await bff.app.request("/api/files/download/check?path=src")).status, 502);
    workspace.checkDownload = async () => ({ ...CHECK, skipped: "node_modules" }) as unknown as SandboxDownloadCheck;
    assert.equal((await bff.app.request("/api/files/download/check?path=src")).status, 502);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/download/check maps sandbox failures", async () => {
  for (const [expected, error] of [
    [404, new SandboxRequestError("Path not found: /workspace/nope", 404)],
    [413, new SandboxRequestError("Download has too many entries (max 10000)", 413)],
    [502, new Error("boom")],
  ] as const) {
    const { workspace } = stubWorkspace({
      checkDownload: async () => {
        throw error as Error;
      },
    });
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
    try {
      const response = await bff.app.request("/api/files/download/check?path=src");
      assert.equal(response.status, expected, error.message);
      assert.deepEqual(await response.json(), { error: error.message });
    } finally {
      await bff.close();
    }
  }
});
