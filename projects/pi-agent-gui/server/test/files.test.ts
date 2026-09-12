// GET /api/files。サンドボックスはスタブを注入し、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SandboxRequestError, type SandboxFilesClient } from "../src/sandbox/client";
import type { SandboxFileListing } from "../src/sandbox/protocol";

const LISTING: SandboxFileListing = {
  path: "src",
  entries: [
    { name: "client", type: "dir" },
    { name: "index.ts", type: "file", size: 12, mtime: 1700000000000 },
  ],
  truncated: false,
};

/** listFiles が受け取った path を記録するスタブ */
function stubFiles(result: SandboxFileListing | Error = LISTING): {
  files: SandboxFilesClient;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    files: {
      listFiles: async (path: string) => {
        paths.push(path);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

test("GET /api/files relays the sandbox listing", async () => {
  const { files, paths } = stubFiles();
  // pi が無くても (ready: false でも) ツリーは開ける
  const bff = await createBffApp({ cwd: "/tmp/project", pi: null, files });
  try {
    const response = await bff.app.request("/api/files?path=src");
    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), LISTING);
    assert.deepEqual(paths, ["src"]);

    // path 省略時は root
    assert.equal((await bff.app.request("/api/files")).status, 200);
    assert.deepEqual(paths, ["src", "."]);

    const health = await jsonBody(bff.app.request("/api/health"));
    assert.equal(health.ready, false, "ファイル一覧はモデルランタイムの有無に依存しない");
  } finally {
    await bff.close();
  }
});

test("GET /api/files answers 503 when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", pi: null, files: null });
  try {
    const response = await bff.app.request("/api/files");
    assert.equal(response.status, 503);
    const body = await jsonBody(response);
    // 画面に理由を出すため、必要な環境変数を本文に含める
    assert.match(body.error, /PI_SANDBOX_URL/);
    assert.match(body.error, /PI_SANDBOX_TOKEN/);
  } finally {
    await bff.close();
  }
});

test("GET /api/files maps sandbox failures and rejects malformed listings", async () => {
  const cases: Array<{ error: Error; status: number; message: RegExp }> = [
    { error: new SandboxRequestError("Path outside the workspace: /etc", 400), status: 400, message: /outside the workspace/ },
    { error: new SandboxRequestError("Path not found: /workspace/nope", 404), status: 404, message: /Path not found/ },
    { error: new SandboxRequestError("サンドボックス (http://x) に接続できません: ECONNREFUSED", 502), status: 502, message: /接続できません/ },
    { error: new Error("unexpected"), status: 502, message: /unexpected/ },
  ];
  for (const item of cases) {
    const { files } = stubFiles(item.error);
    const bff = await createBffApp({ cwd: "/tmp/project", pi: null, files });
    try {
      const response = await bff.app.request("/api/files?path=../../etc");
      assert.equal(response.status, item.status, item.error.message);
      assert.match((await jsonBody(response)).error, item.message);
    } finally {
      await bff.close();
    }
  }

  // サンドボックスが契約外の応答を返した場合は 502 (一覧として信用しない)
  const malformed = stubFiles({
    path: ".",
    entries: [{ name: "sock", type: "socket" } as never],
    truncated: false,
  });
  const bff = await createBffApp({ cwd: "/tmp/project", pi: null, files: malformed.files });
  try {
    const response = await bff.app.request("/api/files");
    assert.equal(response.status, 502);
    assert.match((await jsonBody(response)).error, /不正/);
  } finally {
    await bff.close();
  }
});

test("GET /api/files builds its client from PI_SANDBOX_URL and PI_SANDBOX_TOKEN", async () => {
  const previous = { url: process.env.PI_SANDBOX_URL, token: process.env.PI_SANDBOX_TOKEN };
  // 到達できない URL を指定し、env から生成したクライアントが使われることだけを見る
  process.env.PI_SANDBOX_URL = "http://127.0.0.1:9";
  process.env.PI_SANDBOX_TOKEN = "env-sandbox-token-0123456789";
  try {
    const bff = await createBffApp({ cwd: "/tmp/project", pi: null });
    try {
      const response = await bff.app.request("/api/files");
      assert.equal(response.status, 502);
      assert.match((await jsonBody(response)).error, /接続できません/);
    } finally {
      await bff.close();
    }
  } finally {
    if (previous.url === undefined) delete process.env.PI_SANDBOX_URL;
    else process.env.PI_SANDBOX_URL = previous.url;
    if (previous.token === undefined) delete process.env.PI_SANDBOX_TOKEN;
    else process.env.PI_SANDBOX_TOKEN = previous.token;
  }
});
