// チャットの添付ファイル: BFF のアップロード / raw 配信 / 添付付きメッセージ送信。
// サンドボックスは stub に差し替え、listen せず app.request() で検証する。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hono } from "hono";
import { createBffApp } from "../src/app";
import { MAX_ATTACHMENT_BYTES, UPLOADS_DIR, composePrompt, stripAttachedFiles } from "../src/attachments";
import { SandboxRequestError, createSandboxToolClient, type SandboxWorkspaceClient } from "../src/sandbox/client";
import { createSandboxService } from "../src/sandbox/service";
import { asPiBff, createStubPi, waitFor } from "./stub-pi";

const TOKEN = "test-sandbox-token-0123456789abcdef";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

type UploadCall = { dir: string; name: string; size: number };

/**
 * アップロードの引数と実際に読んだバイト数を記録する workspace stub。
 * 応答の path は実サンドボックスと同じ「root 相対」を返す (BFF の作業フォルダへの変換は BFF の責務)。
 */
function stubWorkspace() {
  const uploads: UploadCall[] = [];
  const rawPaths: string[] = [];
  let rawResult: () => Promise<Awaited<ReturnType<SandboxWorkspaceClient["rawFile"]>>> = async () => ({
    contentType: "image/png",
    contentLength: 5,
    body: new Response("image").body,
  });
  const workspace: SandboxWorkspaceClient = {
    previewFile: async () => ({ text: "" }),
    listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
    createDir: async (path: string) => ({ path }),
    // 削除はこのテストでは扱わない
    deleteFile: async () => {},
    uploadFile: async (input) => {
      let size = 0;
      if (input.body) {
        const reader = input.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
        }
      }
      uploads.push({ dir: input.dir, name: input.name, size });
      return { path: `${input.dir}/${input.name}`, name: input.name, renamed: false, size };
    },
    rawFile: async (path) => {
      rawPaths.push(path);
      return rawResult();
    },
  };
  return {
    workspace,
    uploads,
    rawPaths,
    setRawResult: (value: typeof rawResult) => {
      rawResult = value;
    },
  };
}

/**
 * 実サンドボックスを BFF の workspace に繋ぐ。fetch を socket なしで app.request へ向けるため、
 * アップロードのストリームと raw 配信の契約 (duplex / ステータス写像) を実装同士で確かめられる。
 */
async function appWithRealSandbox(options: { rootCwd: string; maxUploadBytes?: number; sessionStoreDir?: string }) {
  const sandbox = createSandboxService({
    token: TOKEN,
    rootCwd: options.rootCwd,
    ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
  });
  const workspace = createSandboxToolClient({
    baseUrl: "http://sandbox.test",
    token: TOKEN,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
      sandbox.app.request(String(input), init)) as typeof fetch,
  });
  const bff = await createBffApp({
    cwd: options.rootCwd,
    sessionStoreDir: options.sessionStoreDir ?? null,
    pi: asPiBff(createStubPi()),
    workspace: workspace as SandboxWorkspaceClient,
  });
  return {
    bff,
    close: async () => {
      await bff.close();
      sandbox.close();
    },
  };
}

async function createSession(app: Hono): Promise<string> {
  const response = await app.request("/api/sessions", jsonPost({ agentId: "agent-general" }));
  assert.equal(response.status, 201);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

test("POST /api/sessions/:id/files streams the body to the sandbox uploads directory", async () => {
  const { workspace, uploads } = stubWorkspace();
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace,
  });
  try {
    const sessionId = await createSession(bff.app);
    const response = await bff.app.request(`/api/sessions/${sessionId}/files?name=photo.png`, {
      method: "POST",
      body: "fake-image-bytes",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      sessionId,
      path: "uploads/photo.png",
      name: "photo.png",
      renamed: false,
      size: 16,
    });
    assert.deepEqual(uploads, [{ dir: UPLOADS_DIR, name: "photo.png", size: 16 }]);
  } finally {
    await bff.close();
  }
});

test("the upload response path is relative to the session work folder", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "pi-session-store-"));
  const { workspace, uploads } = stubWorkspace();
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: storeDir,
    pi: asPiBff(createStubPi()),
    workspace,
  });
  try {
    const sessionId = await createSession(bff.app);
    const workdir = `.pi-agent-gui/sessions/${sessionId}`;
    const response = await bff.app.request(`/api/sessions/${sessionId}/files?name=photo.png`, {
      method: "POST",
      body: "bytes",
    });
    assert.equal(response.status, 201);
    // サンドボックスは root 相対 (`<workdir>/uploads/photo.png`) を返し、BFF が作業フォルダの前置を剥がす
    assert.equal(uploads[0]?.dir, `${workdir}/uploads`);
    assert.deepEqual(await response.json(), {
      sessionId,
      path: "uploads/photo.png",
      name: "photo.png",
      renamed: false,
      size: 5,
    });

    // uploads/ 配下に解決できない応答は契約違反として 502 (誤ったパスをクライアントへ流さない)
    const original = workspace.uploadFile;
    workspace.uploadFile = async (input) => ({ ...(await original(input)), path: `docs/${input.name}` });
    const invalid = await bff.app.request(`/api/sessions/${sessionId}/files?name=photo.png`, {
      method: "POST",
      body: "bytes",
    });
    assert.equal(invalid.status, 502);
  } finally {
    await bff.close();
  }
});

test("upload route bypasses the 64 KiB bodyGuard for /api", async () => {
  const { workspace, uploads } = stubWorkspace();
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace,
  });
  try {
    const sessionId = await createSession(bff.app);
    const body = new Uint8Array(70 * 1024).fill(7);
    const response = await bff.app.request(`/api/sessions/${sessionId}/files?name=big.bin`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 201, "bodyGuard (64 KiB / text 化) を通さない");
    assert.deepEqual(uploads, [{ dir: UPLOADS_DIR, name: "big.bin", size: body.byteLength }]);
  } finally {
    await bff.close();
  }
});

test("upload route maps sandbox errors and validates the session and the name", async () => {
  const { workspace, setRawResult } = stubWorkspace();
  void setRawResult;
  const bff = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace,
  });
  try {
    assert.equal((await bff.app.request("/api/sessions/nope/files?name=a.png", { method: "POST" })).status, 404);
    const sessionId = await createSession(bff.app);
    for (const name of ["", "..", "a/b.png"]) {
      const rejected = await bff.app.request(`/api/sessions/${sessionId}/files?name=${encodeURIComponent(name)}`, {
        method: "POST",
        body: "x",
      });
      assert.equal(rejected.status, 400, `name=${name} は 400`);
    }
    // 申告された Content-Length が上限を超えるときは本文を送らずに 413
    const oversized = await bff.app.request(`/api/sessions/${sessionId}/files?name=big.bin`, {
      method: "POST",
      headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) },
      body: "x",
    });
    assert.equal(oversized.status, 413);

    workspace.uploadFile = async () => {
      throw new SandboxRequestError("File is too large (max 104857600 bytes)", 413);
    };
    assert.equal(
      (await bff.app.request(`/api/sessions/${sessionId}/files?name=big.bin`, { method: "POST", body: "x" })).status,
      413,
    );
    workspace.uploadFile = async () => ({ path: 42 }) as never;
    assert.equal(
      (await bff.app.request(`/api/sessions/${sessionId}/files?name=a.png`, { method: "POST", body: "x" })).status,
      502,
    );
  } finally {
    await bff.close();
  }

  const unconfigured = await createBffApp({
    cwd: "/tmp/project",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace: null,
  });
  try {
    const response = await unconfigured.app.request("/api/sessions/any/files?name=a.png", { method: "POST" });
    assert.equal(response.status, 503);
    assert.match((await jsonBody(response)).error, /PI_SANDBOX_URL/);
  } finally {
    await unconfigured.close();
  }
});

test("GET /api/files/raw streams the sandbox image with no-store headers", async () => {
  const { workspace, rawPaths } = stubWorkspace();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    const response = await bff.app.request("/api/files/raw?path=uploads%2Fphoto.png");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), "5");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "image");
    assert.deepEqual(rawPaths, ["uploads/photo.png"]);

    // allowlist 外はサンドボックスへ行かずに 400
    for (const path of ["uploads/report.pdf", "uploads/vector.svg", "uploads/page.html"]) {
      const rejected = await bff.app.request(`/api/files/raw?path=${encodeURIComponent(path)}`);
      assert.equal(rejected.status, 400);
    }
    assert.equal(rawPaths.length, 1);
  } finally {
    await bff.close();
  }
});

test("GET /api/files/raw passes sandbox errors through and answers 502 for connection failures", async () => {
  const { workspace, setRawResult } = stubWorkspace();
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace });
  try {
    for (const [status, message] of [
      [404, "Path not found: uploads/x.png"],
      [400, "Path outside the workspace: /etc/x.png"],
      [413, "Image is too large (max 104857600 bytes)"],
    ] as const) {
      setRawResult(async () => {
        throw new SandboxRequestError(message, status);
      });
      const response = await bff.app.request("/api/files/raw?path=uploads%2Fx.png");
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: message });
    }
    setRawResult(async () => {
      throw new SandboxRequestError("サンドボックス (http://sbx) に接続できません", 502);
    });
    assert.equal((await bff.app.request("/api/files/raw?path=uploads%2Fx.png")).status, 502);
    setRawResult(async () => ({ contentType: "image/png", body: null }));
    assert.equal((await bff.app.request("/api/files/raw?path=uploads%2Fx.png")).status, 502);
  } finally {
    await bff.close();
  }

  const unconfigured = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: null, workspace: null });
  try {
    assert.equal((await unconfigured.app.request("/api/files/raw?path=uploads%2Fx.png")).status, 503);
  } finally {
    await unconfigured.close();
  }
});

test("upload and raw delivery work against the real sandbox service", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbx-e2e-"));
  const { bff, close } = await appWithRealSandbox({ rootCwd: root });
  try {
    const sessionId = await createSession(bff.app);
    const body = new Uint8Array(70 * 1024).fill(3);
    const uploaded = await bff.app.request(`/api/sessions/${sessionId}/files?name=chart.png`, {
      method: "POST",
      body,
    });
    assert.equal(uploaded.status, 201);
    const result = (await uploaded.json()) as { path: string; name: string; size: number };
    assert.equal(result.path, "uploads/chart.png");
    assert.equal(result.size, body.byteLength);
    assert.deepEqual(new Uint8Array(await readFile(join(root, "uploads", "chart.png"))), body);

    // 同名は上書きせず連番になる
    const second = await bff.app.request(`/api/sessions/${sessionId}/files?name=chart.png`, {
      method: "POST",
      body: "second",
    });
    assert.equal(((await second.json()) as { name: string }).name, "chart-1.png");

    // BFF の raw はサンドボックスのストリームをヘッダつきで中継する
    const raw = await bff.app.request("/api/files/raw?path=uploads%2Fchart.png");
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    assert.equal(raw.headers.get("content-length"), String(body.byteLength));
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), body);
  } finally {
    await close();
  }
});

test("a persistent session receives the work folder prefix stripped by the BFF", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbx-e2e-workdir-"));
  const storeDir = await mkdtemp(join(tmpdir(), "pi-sbx-e2e-store-"));
  const { bff, close } = await appWithRealSandbox({ rootCwd: root, sessionStoreDir: storeDir });
  try {
    const sessionId = await createSession(bff.app);
    const payload = (await (await bff.app.request(`/api/sessions/${sessionId}`)).json()) as { cwd: string };
    const workdir = `.pi-agent-gui/sessions/${sessionId}`;
    assert.equal(payload.cwd, workdir);

    const body = new Uint8Array([1, 2, 3, 4]);
    const uploaded = await bff.app.request(`/api/sessions/${sessionId}/files?name=dot.png`, {
      method: "POST",
      body,
    });
    assert.equal(uploaded.status, 201);
    // サンドボックスは root 相対で返すが、クライアントへは作業フォルダ相対で返す (二重前置を防ぐ)
    assert.equal(((await uploaded.json()) as { path: string }).path, "uploads/dot.png");
    assert.deepEqual(new Uint8Array(await readFile(join(root, workdir, "uploads", "dot.png"))), body);

    // クライアントと同じ変換 (fileTreeFetchPath) で raw を引ける
    const raw = await bff.app.request(`/api/files/raw?path=${encodeURIComponent(`${workdir}/uploads/dot.png`)}`);
    assert.equal(raw.status, 200);
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), body);

    // 返した path はそのまま attachments として送れる
    const posted = await bff.app.request(
      `/api/sessions/${sessionId}/messages`,
      jsonPost({ text: "これを見て", attachments: ["uploads/dot.png"] }),
    );
    assert.equal(posted.status, 202);
  } finally {
    await close();
  }
});

test("an oversize upload is rejected by the sandbox stream limit as 413", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbx-e2e-limit-"));
  const { bff, close } = await appWithRealSandbox({ rootCwd: root, maxUploadBytes: 1024 });
  try {
    const sessionId = await createSession(bff.app);
    const response = await bff.app.request(`/api/sessions/${sessionId}/files?name=big.bin`, {
      method: "POST",
      body: new Uint8Array(4096).fill(1),
    });
    assert.equal(response.status, 413);
    // 中断した temp も最終ファイルも残さない (ディレクトリは作ってよい)
    assert.deepEqual(await readdir(join(root, "uploads")), []);
  } finally {
    await close();
  }
});

test("uploaded images are servable and other extensions are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sbx-e2e-raw-"));
  const { bff, close } = await appWithRealSandbox({ rootCwd: root });
  try {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "note.txt"), "text");
    assert.equal((await bff.app.request("/api/files/raw?path=uploads%2Fnote.txt")).status, 400);
    assert.equal((await bff.app.request("/api/files/raw?path=uploads%2Fmissing.png")).status, 404);
  } finally {
    await close();
  }
});

test("POST /api/sessions/:id/messages accepts attachments under uploads/ and stores the note", async () => {
  const pi = createStubPi({ chunkDelayMs: 1 });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  try {
    const sessionId = await createSession(bff.app);
    const response = await bff.app.request(
      `/api/sessions/${sessionId}/messages`,
      jsonPost({ text: "これを見て", attachments: ["./uploads/photo.png", "uploads/report.pdf"] }),
    );
    assert.equal(response.status, 202);

    await waitFor(() => pi.sessions[0]?.messages.some((message) => message.role === "user"));
    const payload = await jsonBody(bff.app.request(`/api/sessions/${sessionId}`));
    assert.equal(
      payload.messages[0].text,
      composePrompt("これを見て", ["uploads/photo.png", "uploads/report.pdf"]),
      "履歴には注記込みの本文が入る",
    );
    assert.equal(payload.title, "これを見て", "title は注記を除いた本文から作る");
    assert.equal(stripAttachedFiles(payload.messages[0].text), "これを見て");
  } finally {
    await bff.close();
  }
});

test("POST /api/sessions/:id/messages allows attachments without text and rejects invalid paths", async () => {
  const pi = createStubPi({ chunkDelayMs: 1 });
  const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: null, pi: asPiBff(pi) });
  try {
    const sessionId = await createSession(bff.app);

    const noText = await bff.app.request(
      `/api/sessions/${sessionId}/messages`,
      jsonPost({ text: "  ", attachments: ["uploads/photo.png"] }),
    );
    assert.equal(noText.status, 202);

    const rejected: Array<{ text: string; attachments: unknown[] }> = [
      { text: "x", attachments: Array.from({ length: 11 }, (_, index) => `uploads/${index}.png`) },
      { text: "x", attachments: ["docs/photo.png"] },
      { text: "x", attachments: ["uploads/../secret.png"] },
      { text: "x", attachments: ["/uploads/photo.png"] },
      { text: "x", attachments: ["uploads"] },
      { text: "x", attachments: [42 as unknown as string] },
    ];
    for (const body of rejected) {
      const response = await bff.app.request(`/api/sessions/${sessionId}/messages`, jsonPost(body));
      assert.equal(response.status, 400, JSON.stringify(body.attachments));
    }
    // 本文も添付も無い送信は従来どおり 400
    assert.equal((await bff.app.request(`/api/sessions/${sessionId}/messages`, jsonPost({ text: " " }))).status, 400);
  } finally {
    await bff.close();
  }
});
