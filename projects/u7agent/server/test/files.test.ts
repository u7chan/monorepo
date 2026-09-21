// GET / DELETE /api/files。サンドボックスはスタブを注入し、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { HTML_PREVIEW_CSP_BY_POLICY, HTML_PREVIEW_POLICY } from "../src/routes/files";
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

/** サンドボックスのメソッドが受け取った path を記録するスタブ */
function stubFiles(result: SandboxFileListing | Error = LISTING): {
  workspace: SandboxWorkspaceClient;
  paths: string[];
  deleted: string[];
  deletedDirs: string[];
  previewed: string[];
  raw: string[];
} {
  const paths: string[] = [];
  const deleted: string[] = [];
  const deletedDirs: string[] = [];
  const previewed: string[] = [];
  const raw: string[] = [];
  return {
    paths,
    deleted,
    deletedDirs,
    previewed,
    raw,
    workspace: {
      previewFile: async (path: string) => {
        previewed.push(path);
        return { text: "hello" };
      },
      listFiles: async (path: string) => {
        paths.push(path);
        if (result instanceof Error) throw result;
        return result;
      },
      // ファイルスキルの発見はこのテストでは扱わない
      listSkills: async () => ({ skills: [] }),
      // ファイル一覧のテストではディレクトリ作成は使わない
      createDir: async (path: string) => ({ path }),
      deleteFile: async (path: string) => {
        deleted.push(path);
      },
      deleteDirectory: async (path: string) => {
        deletedDirs.push(path);
      },
      // アップロードはこのテストでは扱わない
      uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
      rawFile: async (path: string) => {
        raw.push(path);
        return { contentType: "image/png", body: null };
      },
    },
  };
}

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** iframe へ流す CSP。段階 (Lv) ごとの値を 1 箇所で固定する (iframe 側の sandbox 属性は client のテストが見る) */
const CSP_INLINE =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'";
const CSP_ASSETS =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data: 'self'; media-src data: blob: 'self'; form-action 'none'";
const CSP_CDN =
  "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self' https:; script-src 'unsafe-inline' 'self' https:; img-src data: blob: 'self' https:; font-src data: 'self' https:; media-src data: blob: 'self' https:; form-action 'none'";

test("HTML プレビューのポリシーは段階ごとの CSP に固定する", () => {
  assert.equal(HTML_PREVIEW_CSP_BY_POLICY.inline, CSP_INLINE);
  assert.equal(HTML_PREVIEW_CSP_BY_POLICY.assets, CSP_ASSETS);
  assert.equal(HTML_PREVIEW_CSP_BY_POLICY.cdn, CSP_CDN);
  assert.equal(HTML_PREVIEW_POLICY, "cdn", "既定は Lv2 (相対アセット + https:) を想定する");
  // 外部 URL は Lv2 からのみ許可する
  assert.ok(!HTML_PREVIEW_CSP_BY_POLICY.inline.includes("https:"), "inline で外部 URL を許可している");
  assert.ok(!HTML_PREVIEW_CSP_BY_POLICY.assets.includes("https:"), "assets で外部 URL を許可している");
  // connect-src を足すとオペークオリジンから POST できてしまうため、どの段階にも入れない
  for (const [level, csp] of Object.entries(HTML_PREVIEW_CSP_BY_POLICY)) {
    assert.ok(!csp.includes("connect-src"), `${level} に connect-src がある`);
  }
});

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

test("GET /api/files/html/<path> returns .html as an isolated HTML document", async () => {
  const { workspace } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    workspace.previewFile = async (path) => ({ text: `<h1>${path}</h1>` });
    const response = await bff.app.request("/api/files/html/report%2Fchart.html");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
    // iframe を隔離するヘッダを固定する (CSP は既定ポリシーの値をそのまま見る)
    assert.equal(response.headers.get("Content-Security-Policy"), CSP_CDN);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    // 本文はサンドボックスが返したテキストをそのまま返す (本文の拡張子は見ない)
    assert.equal(await response.text(), "<h1>report/chart.html</h1>");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> decodes the path parameter exactly once", async () => {
  const { workspace, previewed } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    // クライアントはセグメント単位で encodeURIComponent する (`#` / `?` / `%` を URL の区切りにしない)
    const cases: Array<[string, string]> = [
      ["/api/files/html/dir%2Ffile.html", "dir/file.html"],
      ["/api/files/html/a%20b.html", "a b.html"],
      ["/api/files/html/%E6%97%A5%E6%9C%AC%E8%AA%9E%2Fa.html", "日本語/a.html"],
      ["/api/files/html/a%23b.html", "a#b.html"],
      ["/api/files/html/a%3Fb.html", "a?b.html"],
      ["/api/files/html/a+b.html", "a+b.html"],
      ["/api/files/html/a%252Fb.html", "a%2Fb.html"],
    ];
    for (const [url, expected] of cases) {
      assert.equal((await bff.app.request(url)).status, 200, url);
      assert.equal(previewed.at(-1), expected, url);
    }
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html without a path is a JSON 404, not an HTML document", async () => {
  const { workspace } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    for (const url of ["/api/files/html", "/api/files/html/"]) {
      const response = await bff.app.request(url);
      assert.equal(response.status, 404, url);
      assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/, url);
      assert.deepEqual(await jsonBody(response), { error: "Not found" }, url);
    }
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> serves images from the sandbox raw path", async () => {
  const { workspace, previewed, raw } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    workspace.rawFile = async (path) => {
      raw.push(path);
      return {
        contentType: "image/png",
        contentLength: 3,
        body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
      };
    };
    const response = await bff.app.request("/api/files/html/dir%2Fcat.PNG");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(response.headers.get("Content-Length"), "3");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    // 文書だけに CSP を当てる (画像はサブリソース)
    assert.equal(response.headers.get("Content-Security-Policy"), null);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.deepEqual(raw, ["dir/cat.PNG"]);
    assert.deepEqual(previewed, [], "画像を preview 経路で読んでいる");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> serves text assets with an extension-specific Content-Type", async () => {
  const { workspace, previewed, raw } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const cases: Array<[string, string]> = [
      ["/api/files/html/dir%2Fapp.js", "text/javascript; charset=utf-8"],
      ["/api/files/html/app.mjs", "text/javascript; charset=utf-8"],
      ["/api/files/html/dir%2Fapp.css", "text/css; charset=utf-8"],
      ["/api/files/html/data.json", "application/json; charset=utf-8"],
      ["/api/files/html/notes.txt", "text/plain; charset=utf-8"],
    ];
    for (const [url, contentType] of cases) {
      const response = await bff.app.request(url);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get("Content-Type"), contentType, url);
      assert.equal(response.headers.get("Cache-Control"), "no-store", url);
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", url);
      // サブリソースに text/html を返さない (nosniff で MIME エラーにする)
      assert.equal(response.headers.get("Content-Security-Policy"), null, url);
      assert.equal(await response.text(), "hello", url);
    }
    assert.deepEqual(previewed, ["dir/app.js", "app.mjs", "dir/app.css", "data.json", "notes.txt"]);
    assert.deepEqual(raw, [], "テキストアセットを raw 経路で読んでいる");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> rejects extensions that are not servable as assets", async () => {
  const { workspace, previewed, raw } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    // .svg は同一オリジンでスクリプトが動くため配信しない。拡張子なし / dotfile / Object.prototype の名前も対象外にする
    for (const url of [
      "/api/files/html/dir%2Flogo.svg",
      "/api/files/html/app.js.map",
      "/api/files/html/data.yaml",
      "/api/files/html/a.woff2",
      "/api/files/html/dir%2F",
      "/api/files/html/.js",
      "/api/files/html/x.constructor",
      "/api/files/html/x.__proto__",
    ]) {
      const response = await bff.app.request(url);
      assert.equal(response.status, 400, url);
      assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/, url);
      assert.match((await jsonBody(response)).error, /^Not a servable asset: /, url);
    }
    assert.deepEqual(previewed, [], "配信しない拡張子をサンドボックスへ読ませている");
    assert.deepEqual(raw, []);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> maps document failures to HTML documents", async () => {
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
      const response = await bff.app.request("/api/files/html/chart.html");
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
    const response = await bff.app.request("/api/files/html/chart.html");
    assert.equal(response.status, 502);
    assert.match(await response.text(), /不正/);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> maps asset failures to JSON", async () => {
  const cases: Array<{ error: Error; status: number; message: RegExp }> = [
    {
      error: new SandboxRequestError("Path outside the workspace: /etc", 400),
      status: 400,
      message: /outside the workspace/,
    },
    { error: new SandboxRequestError("Path not found: /workspace/nope", 404), status: 404, message: /Path not found/ },
    {
      error: new SandboxRequestError("プレビューは256 KiB以下のファイルに対応しています", 400),
      status: 400,
      message: /256 KiB/,
    },
    {
      error: new SandboxRequestError("サンドボックス (http://x) に接続できません: ECONNREFUSED", 502),
      status: 502,
      message: /接続できません/,
    },
    { error: new SandboxRequestError("サンドボックスが応答しません", 503), status: 503, message: /応答しません/ },
    { error: new Error("unexpected"), status: 502, message: /unexpected/ },
  ];
  for (const item of cases) {
    const { workspace } = stubFiles();
    workspace.previewFile = async () => {
      throw item.error;
    };
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
    try {
      const response = await bff.app.request("/api/files/html/dir%2Fapp.js");
      assert.equal(response.status, item.status, item.error.message);
      // サブリソースに HTML 文書を返すと nosniff 下で MIME エラーになるため JSON で返す
      assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/, item.error.message);
      assert.match((await jsonBody(response)).error, item.message);
    } finally {
      await bff.close();
    }
  }
});

test("GET /api/files/html/<path> escapes the sandbox message", async () => {
  const { workspace } = stubFiles();
  workspace.previewFile = async () => {
    throw new SandboxRequestError('<b onclick="x()">nope</b>', 404);
  };
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/html/chart.html");
    const body = await response.text();
    assert.match(body, /&lt;b onclick=&quot;x\(\)&quot;&gt;nope&lt;\/b&gt;/);
    assert.ok(!body.includes("<b onclick"), "サンドボックス由来の文言をそのまま HTML に入れている");
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> answers 503 as an HTML document when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    const response = await bff.app.request("/api/files/html/chart.html");
    assert.equal(response.status, 503);
    assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
    const body = await response.text();
    assert.match(body, /PI_SANDBOX_URL/);
    assert.match(body, /PI_SANDBOX_TOKEN/);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/html/<path> answers 503 as JSON for assets when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    for (const url of ["/api/files/html/dir%2Fapp.js", "/api/files/html/dir%2Fcat.png"]) {
      const response = await bff.app.request(url);
      assert.equal(response.status, 503, url);
      assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/, url);
      assert.match((await jsonBody(response)).error, /PI_SANDBOX_URL/);
    }
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

test("DELETE /api/files deletes through the sandbox and returns 204 without a body", async () => {
  const { workspace, deleted, deletedDirs } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files?path=uploads%2Fphoto.png", { method: "DELETE" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.deepEqual(deleted, ["uploads/photo.png"]);
    assert.deepEqual(deletedDirs, [], "recursive なしでディレクトリ削除を呼んでいる");

    // path を省略した場合は root 相当を渡し、検証はサンドボックスに任せる
    assert.equal((await bff.app.request("/api/files", { method: "DELETE" })).status, 204);
    assert.deepEqual(deleted, ["uploads/photo.png", ""]);
  } finally {
    await bff.close();
  }
});

test("DELETE /api/files delegates recursive=true to the sandbox directory delete", async () => {
  const { workspace, deleted, deletedDirs } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files?path=dir%2Fsub&recursive=true", { method: "DELETE" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.deepEqual(deletedDirs, ["dir/sub"]);
    assert.deepEqual(deleted, [], "recursive=true でファイル削除を呼んではいけない");

    // path を省略した場合も recursive の指定はそのままサンドボックスへ渡す
    assert.equal((await bff.app.request("/api/files?recursive=true", { method: "DELETE" })).status, 204);
    assert.deepEqual(deletedDirs, ["dir/sub", ""]);
  } finally {
    await bff.close();
  }
});

test("DELETE /api/files rejects recursive values that are not exactly true, without deleting", async () => {
  const { workspace, deleted, deletedDirs } = stubFiles();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const queries = [
      "/api/files?path=dir&recursive=false",
      "/api/files?path=dir&recursive=1",
      "/api/files?path=dir&recursive=TRUE",
      "/api/files?path=dir&recursive=",
      "/api/files?path=dir&recursive=true&recursive=true",
      "/api/files?path=dir&recursive=true&recursive=false",
    ];
    for (const url of queries) {
      const response = await bff.app.request(url, { method: "DELETE" });
      assert.equal(response.status, 400, url);
      assert.match((await jsonBody(response)).error, /recursive/, url);
    }
    assert.deepEqual(deleted, [], "不正な recursive でファイル削除を呼んでいる");
    assert.deepEqual(deletedDirs, [], "不正な recursive でディレクトリ削除を呼んでいる");
  } finally {
    await bff.close();
  }
});

test("DELETE /api/files answers 503 when the sandbox is not configured", async () => {
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    for (const url of ["/api/files?path=uploads%2Fphoto.png", "/api/files?path=dir&recursive=true"]) {
      const response = await bff.app.request(url, { method: "DELETE" });
      assert.equal(response.status, 503, url);
      const body = await jsonBody(response);
      assert.match(body.error, /PI_SANDBOX_URL/, url);
      assert.match(body.error, /PI_SANDBOX_TOKEN/, url);
    }
  } finally {
    await bff.close();
  }
});

test("DELETE /api/files maps sandbox failures", async () => {
  const cases: Array<{ error: Error; status: number; message: RegExp }> = [
    {
      error: new SandboxRequestError("Path outside the workspace: /etc", 400),
      status: 400,
      message: /outside the workspace/,
    },
    { error: new SandboxRequestError("Path not found: /workspace/nope", 404), status: 404, message: /Path not found/ },
    {
      error: new SandboxRequestError("Symbolic links cannot be deleted: /workspace/link", 400),
      status: 400,
      message: /Symbolic links cannot be deleted/,
    },
    {
      error: new SandboxRequestError("Directory is not empty: /workspace/dir", 400),
      status: 400,
      message: /not empty/,
    },
    {
      error: new SandboxRequestError("サンドボックス (http://x) に接続できません: ECONNREFUSED", 502),
      status: 502,
      message: /接続できません/,
    },
    { error: new Error("unexpected"), status: 502, message: /unexpected/ },
  ];
  for (const item of cases) {
    const { workspace } = stubFiles();
    workspace.deleteFile = async () => {
      throw item.error;
    };
    workspace.deleteDirectory = async () => {
      throw item.error;
    };
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
    try {
      for (const url of ["/api/files?path=uploads%2Fphoto.png", "/api/files?path=dir&recursive=true"]) {
        const response = await bff.app.request(url, { method: "DELETE" });
        assert.equal(response.status, item.status, `${item.error.message} (${url})`);
        assert.match((await jsonBody(response)).error, item.message, url);
      }
    } finally {
      await bff.close();
    }
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
