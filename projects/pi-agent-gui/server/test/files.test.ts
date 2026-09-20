// GET /api/files。サンドボックスはスタブを注入し、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SandboxRequestError, type SandboxWorkspaceClient } from "../src/sandbox/client";
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
  workspace: SandboxWorkspaceClient;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    workspace: {
      previewFile: async () => ({ text: "hello" }),
      listFiles: async (path: string) => {
        paths.push(path);
        if (result instanceof Error) throw result;
        return result;
      },
      // ファイル一覧のテストではディレクトリ作成は使わない
      createDir: async (path: string) => ({ path }),
      // アップロード / 生配信はこのテストでは扱わない
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async () => ({ contentType: "image/png", body: null }),
    },
  };
}

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** iframe へ流す CSP。値まで 1 箇所で固定する (iframe 側の sandbox 属性は client のテストが見る) */
const HTML_CSP =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'";

test("GET /api/files/preview validates responses and does not cache content", async () => {
  const { workspace } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    workspace.previewFile = async (path) => ({ text: path });
    const response = await bff.app.request("/api/files/preview?path=src%2Fhello.txt");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { text: "src/hello.txt" });
    workspace.previewFile = async () => ({ text: 42 }) as unknown as { text: string };
    assert.equal((await bff.app.request("/api/files/preview?path=x")).status, 502);
    workspace.previewFile = async () => {
      throw new SandboxRequestError("missing", 404);
    };
    assert.equal((await bff.app.request("/api/files/preview?path=x")).status, 404);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/preview answers 503 when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    assert.equal((await bff.app.request("/api/files/preview?path=README.md")).status, 503);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html returns the text as an isolated HTML document", async () => {
  const { workspace } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    workspace.previewFile = async (path) => ({ text: `<h1>${path}</h1>` });
    const response = await bff.app.request("/api/files/html?path=report%2Fchart.html");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
    // iframe を隔離するヘッダを固定する (CSP は値をそのまま見る)
    assert.equal(response.headers.get("Content-Security-Policy"), HTML_CSP);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    // 本文はサンドボックスが返したテキストをそのまま返す (拡張子はサーバーでは見ない)
    assert.equal(await response.text(), "<h1>report/chart.html</h1>");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html maps sandbox failures to HTML documents", async () => {
  const cases: Array<{ error: Error; status: number; message: RegExp }> = [
    {
      error: new SandboxRequestError("Path outside the workspace: /etc", 400),
      status: 400,
      message: /outside the workspace/,
    },
    { error: new SandboxRequestError("Path not found: /workspace/nope", 404), status: 404, message: /Path not found/ },
    {
      error: new SandboxRequestError("サンドボックス (http://x) に接続できません: ECONNREFUSED", 502),
      status: 502,
      message: /接続できません/,
    },
    { error: new Error("unexpected"), status: 502, message: /unexpected/ },
  ];
  for (const item of cases) {
    const { workspace } = stubFiles();
    workspace.previewFile = async () => {
      throw item.error;
    };
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
    try {
      const response = await bff.app.request("/api/files/html?path=chart.html");
      assert.equal(response.status, item.status, item.error.message);
      // iframe の中でも理由が読めるように、エラーも HTML 文書で返す
      assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
      const body = await response.text();
      assert.match(body, item.message);
      assert.match(body, new RegExp(`HTTP ${item.status}`));
    } finally {
      await bff.close();
    }
  }

  // 契約外の応答も JSON に戻さない (iframe の中で読めなくなる)
  const { workspace } = stubFiles();
  workspace.previewFile = async () => ({ text: 42 }) as unknown as { text: string };
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/html?path=chart.html");
    assert.equal(response.status, 502);
    assert.match(await response.text(), /不正/);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html escapes the sandbox message", async () => {
  const { workspace } = stubFiles();
  workspace.previewFile = async () => {
    throw new SandboxRequestError('<b onclick="x()">nope</b>', 404);
  };
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/html?path=chart.html");
    const body = await response.text();
    assert.match(body, /&lt;b onclick=&quot;x\(\)&quot;&gt;nope&lt;\/b&gt;/);
    assert.ok(!body.includes("<b onclick"), "サンドボックス由来の文言をそのまま HTML に入れている");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html answers 503 as an HTML document when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    const response = await bff.app.request("/api/files/html?path=chart.html");
    assert.equal(response.status, 503);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
    const body = await response.text();
    assert.match(body, /PI_SANDBOX_URL/);
    assert.match(body, /PI_SANDBOX_TOKEN/);
  } finally {
    await bff.close();
  }
});

test("GET /api/files relays the sandbox listing", async () => {
  const { workspace, paths } = stubFiles();
  // pi が無くても (ready: false でも) ツリーは開ける
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
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
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
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
    {
      error: new SandboxRequestError("Path outside the workspace: /etc", 400),
      status: 400,
      message: /outside the workspace/,
    },
    { error: new SandboxRequestError("Path not found: /workspace/nope", 404), status: 404, message: /Path not found/ },
    {
      error: new SandboxRequestError("サンドボックス (http://x) に接続できません: ECONNREFUSED", 502),
      status: 502,
      message: /接続できません/,
    },
    { error: new Error("unexpected"), status: 502, message: /unexpected/ },
  ];
  for (const item of cases) {
    const { workspace } = stubFiles(item.error);
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
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
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: null,
    workspace: malformed.workspace,
  });
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
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null });
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
