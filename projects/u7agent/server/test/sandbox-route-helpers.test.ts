import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SANDBOX_MAX_BODY_BYTES, SANDBOX_MAX_HANDOFF_BYTES, SANDBOX_MAX_PREVIEW_BYTES } from "../src/sandbox/protocol";
import { workspaceEntryName } from "../src/sandbox/fs-path";
import { createSandboxService } from "../src/sandbox/service";

async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-route-helpers-"));
  const token = "test-sandbox-route-token";
  const { app, close } = createSandboxService({ token, rootCwd: root, homeDir: root });
  t.after(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, { ...init, headers: { Authorization: `Bearer ${token}` } });
  return { root, request };
}

test("existing entry names reject root forms, terminal dot segments and trailing slashes", () => {
  for (const path of ["", ".", "..", "/", "dir/.", "dir/..", "dir/file/"]) {
    assert.equal(workspaceEntryName(path), undefined, JSON.stringify(path));
  }
  assert.equal(workspaceEntryName("dir/../leaf.txt"), "leaf.txt");
  assert.equal(workspaceEntryName("dir/old\tname.txt"), "old\tname.txt");
});

test("JSON routes report malformed bodies before field validation", async (t) => {
  const { request } = await sandbox(t);
  for (const [method, path] of [
    ["POST", "/v1/tools/read/execute"],
    ["POST", "/v1/skills/file"],
    ["PATCH", "/v1/skills/file"],
    ["POST", "/v1/files/handoff"],
    ["POST", "/v1/files/handoff/rollback"],
    ["POST", "/v1/files/move"],
    ["POST", "/v1/files/rename"],
    ["POST", "/v1/dirs"],
  ]) {
    const response = await request(path, { method, body: "[" });
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "Unexpected end of JSON input" });
  }
  const unknown = await request("/v1/tools/unknown/execute", { method: "POST", body: "[" });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "Unknown tool: unknown" });
});

test("JSON body overflow is 413, even when the contents are not valid JSON", async (t) => {
  const { request } = await sandbox(t);
  const response = await request("/v1/dirs", { method: "POST", body: "[".repeat(SANDBOX_MAX_BODY_BYTES + 1) });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body is too large" });
});

test("an unclassified body stream error uses the fallback status of each route", async (t) => {
  const { request } = await sandbox(t);
  for (const [path, status] of [
    ["/v1/dirs", 400],
    ["/v1/files/upload?name=note.txt", 500],
  ] as const) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body stream interrupted"));
      },
    });
    const response = await request(path, { method: "POST", body, duplex: "half" } as RequestInit);
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { error: "body stream interrupted" });
  }
});

test("move checks source syntax, then destination syntax, then source existence", async (t) => {
  const { request } = await sandbox(t);
  for (const [from, error] of [
    ["missing/", "Not a file or directory: missing/"],
    ["missing/leaf.txt", "Invalid name: dir/"],
  ]) {
    const response = await request("/v1/files/move", {
      method: "POST",
      body: JSON.stringify({ from, to: "dir/" }),
    });
    assert.equal(response.status, 400, from);
    assert.deepEqual(await response.json(), { error });
  }
});

test("download accepts the workspace root and trailing slashes", async (t) => {
  const { root, request } = await sandbox(t);
  await mkdir(join(root, "dir"));
  const check = async (path: string) => {
    const response = await request(`/v1/files/download/check?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200, JSON.stringify(path));
    return await response.json();
  };
  const workspace = await check("");
  assert.deepEqual(await check("."), workspace);
  assert.deepEqual(await check("/"), workspace);
  assert.deepEqual(await check("dir/"), await check("dir"));
});

test("preview and handoff report size before UTF-8 before binary, with their own messages", async (t) => {
  const { root, request } = await sandbox(t);
  const path = join(root, "note.md");
  for (const { route, limit, messages } of [
    {
      route: "preview",
      limit: SANDBOX_MAX_PREVIEW_BYTES,
      messages: [
        "プレビューは2 MiB以下のファイルに対応しています",
        "UTF-8のテキストファイルのみプレビューできます",
        "バイナリファイルはプレビューできません",
      ],
    },
    {
      route: "handoff",
      limit: SANDBOX_MAX_HANDOFF_BYTES,
      messages: [
        "HANDOFF.md は 2 MiB 以下にしてください",
        "HANDOFF.md は UTF-8 のテキストファイルにしてください",
        "バイナリの HANDOFF.md は扱えません",
      ],
    },
  ]) {
    for (const [data, error] of [
      [Buffer.alloc(limit + 1, 0xff), messages[0]],
      [Buffer.from([0x00, 0xff]), messages[1]],
      [Buffer.from([0x00]), messages[2]],
    ] as const) {
      await writeFile(path, data);
      const response = await request(`/v1/files/${route}?path=note.md`);
      assert.equal(response.status, 400, route);
      assert.deepEqual(await response.json(), { error });
    }
  }
});
