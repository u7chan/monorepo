// listen せず app.request() で検証する。SDK のローカルツール実装と実ファイルシステム / bash だけを使い、実 LLM API は呼ばない。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import { SANDBOX_MAX_FILE_ENTRIES, type SandboxEvent, type SandboxFileListing } from "../src/sandbox/protocol";

const TOKEN = "test-sandbox-token-0123456789abcdef";
const HAS_BASH = existsSync("/bin/bash");
const SKIP_REASON = "bash is not available on this platform";
// Windows では開発者モードが無いと symlink を作れない
const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function readEvents(response: Response): Promise<SandboxEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SandboxEvent);
}

/** GET /v1/files のヘルパ (JSON 応答) */
async function listFiles(
  app: ReturnType<typeof createSandboxService>["app"],
  path?: string,
): Promise<{ status: number; body: SandboxFileListing & { error?: string } }> {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  const response = await app.request(`/v1/files${query}`, { headers: authHeaders() });
  return { status: response.status, body: (await response.json()) as SandboxFileListing & { error?: string } };
}

function eventText(payload: unknown): string {
  const content = (payload as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

test("healthz is public and reports tools without secrets", async () => {
  const service = createSandboxService({ token: TOKEN, rootCwd: join(tmpdir(), "pi-sbx-health") });
  const response = await service.app.request("/healthz");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; tools: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual([...body.tools].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});

test("rejects unauthenticated requests to /v1/*", async () => {
  const service = createSandboxService({ token: TOKEN, rootCwd: join(tmpdir(), "pi-sbx-auth") });
  const noHeader = await service.app.request("/v1/tools/bash/execute", { method: "POST" });
  assert.equal(noHeader.status, 401);
  const wrongToken = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token-0123456789abcdef" },
  });
  assert.equal(wrongToken.status, 401);
  // /v1 以下は認証前に 404 にならない (unknown tool でも認証が先)
  const unknown = await service.app.request("/v1/tools/nope/execute", {
    method: "POST",
    headers: authHeaders(),
  });
  assert.equal(unknown.status, 404);
});

test("executes bash and streams start/update/result events", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-bash-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ toolCallId: "call-1", params: { command: "echo hello-sandbox" } }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const events = await readEvents(response);
  assert.equal(events[0].type, "start");
  assert.ok("executionId" in events[0] && events[0].executionId.length > 0);
  const result = events.find((event) => event.type === "result");
  assert.ok(result, "result event expected");
  assert.match(eventText((result as { payload: unknown }).payload), /hello-sandbox/);
  assert.ok(!events.some((event) => event.type === "error"));
});

test("resolves paths against the sandbox root cwd and persists files", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-cwd-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/write/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { path: "notes/hello.txt", content: "from sandbox" } }),
  });
  const events = await readEvents(response);
  assert.ok(events.some((event) => event.type === "result"), "write should succeed");
  // 相対パスは rootCwd 基準で解決される
  assert.equal(await readFile(join(root, "notes/hello.txt"), "utf8"), "from sandbox");
});

test("read tool returns file content from the sandbox filesystem", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-read-"));
  await writeFile(join(root, "sample.txt"), "sample-body", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const response = await service.app.request("/v1/tools/read/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { path: "sample.txt" } }),
  });
  const events = await readEvents(response);
  const result = events.find((event) => event.type === "result");
  assert.ok(result, "read should succeed");
  assert.match(eventText((result as { payload: unknown }).payload), /sample-body/);
});

test("cancels a running execution via the cancel endpoint", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-cancel-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const began = Date.now();
  const response = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: { command: "sleep 5; echo late" } }),
  });
  // start イベントを拾いながら並行で読み進める
  const events: SandboxEvent[] = [];
  let streamClosed = false;
  const consuming = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) events.push(JSON.parse(line) as SandboxEvent);
        index = buffer.indexOf("\n");
      }
    }
    streamClosed = true;
  })();
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  const start = events.find((event) => event.type === "start");
  assert.ok(start && "executionId" in start, "start event should arrive while sleep is running");
  const cancelled = await service.app.request(
    `/v1/executions/${start.executionId}/cancel`,
    { method: "POST", headers: authHeaders() },
  );
  assert.equal(cancelled.status, 200);
  // 実行は 5 秒待たずに中断され、ストリームが閉じる
  const timeout = new Promise((_, rejectTimeout) =>
    setTimeout(() => rejectTimeout(new Error("execution did not settle in time")), 4000),
  );
  await Promise.race([consuming, timeout]);
  assert.ok(streamClosed, "stream must close after cancel");
  assert.ok(Date.now() - began < 4500, "cancel must not wait for the sleep to finish");
  assert.ok(!service.executions.has(start.executionId), "execution must be cleaned up");
});

test("sandbox bash does not expose the shared token or session env to child processes", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-env-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  // 実起動と同じく、共有トークンが process.env にある状態を再現する
  const previous = process.env.PI_SANDBOX_TOKEN;
  process.env.PI_SANDBOX_TOKEN = TOKEN;
  try {
    const response = await service.app.request("/v1/tools/bash/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        params: {
          command:
            'if [ -n "$PI_SANDBOX_TOKEN" ]; then echo TOKEN_LEAKED; fi; echo session=${PI_SESSION_ID:-unset}',
        },
      }),
    });
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");
    assert.ok(result, "command should succeed");
    const text = eventText((result as { payload: unknown }).payload);
    assert.ok(!text.includes("TOKEN_LEAKED"), "PI_SANDBOX_TOKEN must not be inherited by tool child processes");
    assert.ok(!text.includes(TOKEN), "PI_SANDBOX_TOKEN must not leak into tool output");
    assert.match(text, /session=unset/, "session metadata env vars must be unset");
  } finally {
    if (previous === undefined) delete process.env.PI_SANDBOX_TOKEN;
    else process.env.PI_SANDBOX_TOKEN = previous;
  }
});

test("unknown tool and invalid params return 4xx", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-invalid-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const notObject = await service.app.request("/v1/tools/bash/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ params: ["not-an-object"] }),
  });
  assert.equal(notObject.status, 400);
});

test("close aborts all running executions", { skip: !HAS_BASH && SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-close-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  Promise.resolve(
    service.app.request("/v1/tools/bash/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params: { command: "sleep 5" } }),
    }),
  ).catch(() => {});
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  assert.ok(service.executions.size > 0, "a running execution should be tracked");
  service.close();
  assert.equal(service.executions.size, 0);
});

// rg が手元に無くても grep/find が SDK 経由で壊れないことの最低限確認
test("grep tool reports missing ripgrep as an error event instead of hanging", async () => {
  const rg = spawnSync("rg", ["--version"], { stdio: "ignore" });
  if (rg.status !== 0) {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-norg-"));
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    const response = await service.app.request("/v1/tools/grep/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params: { pattern: "x" } }),
    });
    const events = await readEvents(response);
    assert.ok(events.some((event) => event.type === "error" || event.type === "result"));
  } else {
    // rg がある環境では実行して結果が出ることだけ見る
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-rg-"));
    await writeFile(join(root, "hay.txt"), "needle here\n", "utf8");
    const service = createSandboxService({ token: TOKEN, rootCwd: root });
    const response = await service.app.request("/v1/tools/grep/execute", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params: { pattern: "needle" } }),
    });
    const events = await readEvents(response);
    const result = events.find((event) => event.type === "result");
    assert.ok(result, "grep should succeed");
    assert.match(eventText((result as { payload: unknown }).payload), /needle/);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/files (作業領域の一覧)
// ---------------------------------------------------------------------------

/** 一覧テスト用の小さなツリー (並び順・symlink・ドットファイル) */
async function createListingRoot(prefix: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  await mkdir(join(root, "dirB"));
  await mkdir(join(root, "DirA"));
  await mkdir(join(root, "dirB", "nested"));
  await writeFile(join(root, "b.txt"), "b", "utf8");
  await writeFile(join(root, "A.txt"), "a", "utf8");
  await writeFile(join(root, ".hidden"), "dot", "utf8");
  await writeFile(join(root, "dirB", "nested", "deep.txt"), "deep", "utf8");
  return root;
}

test("files endpoint requires the bearer token", async () => {
  const root = await createListingRoot("pi-sbx-files-auth-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  assert.equal((await service.app.request("/v1/files")).status, 401);
  assert.equal(
    (await service.app.request("/v1/files", { headers: { Authorization: "Bearer wrong-token-0123456789abcdef" } }))
      .status,
    401,
  );
});

test("files endpoint lists directories first, then files, case-insensitively", async () => {
  const root = await createListingRoot("pi-sbx-files-list-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const rootListing = await listFiles(service.app);
  assert.equal(rootListing.status, 200);
  assert.equal(rootListing.body.path, ".");
  assert.equal(rootListing.body.truncated, false);
  assert.deepEqual(
    rootListing.body.entries.map((entry) => `${entry.type}:${entry.name}`),
    ["dir:DirA", "dir:dirB", "file:.hidden", "file:A.txt", "file:b.txt"],
  );
  // ファイルには size / mtime が付き、ディレクトリには付かない
  const file = rootListing.body.entries.find((entry) => entry.name === "A.txt");
  assert.equal(file?.size, 1);
  assert.equal(typeof file?.mtime, "number");
  assert.ok((file?.mtime ?? 0) > 0);
  assert.equal(rootListing.body.entries.find((entry) => entry.type === "dir")?.size, undefined);
  // symlink でないエントリには symlink を付けない
  assert.ok(rootListing.body.entries.every((entry) => entry.symlink === undefined));

  const nested = await listFiles(service.app, "dirB");
  assert.equal(nested.status, 200);
  assert.equal(nested.body.path, "dirB");
  assert.deepEqual(
    nested.body.entries.map((entry) => entry.name),
    ["nested"],
  );
});

test("files endpoint resolves .. inside the root but rejects paths outside it", async () => {
  const root = await createListingRoot("pi-sbx-files-root-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  // 「.. の有無」ではなく「解決後の実パスが root 内か」で判定する
  const stayed = await listFiles(service.app, "dirB/..");
  assert.equal(stayed.status, 200);
  assert.equal(stayed.body.path, ".");
  assert.equal(stayed.body.truncated, false);

  for (const outside of ["..", "../..", "../../etc", "/etc"]) {
    const response = await listFiles(service.app, outside);
    assert.equal(response.status, 400, `${outside} must be rejected`);
    assert.match(response.body.error ?? "", /outside the workspace/);
    assert.equal(response.body.entries, undefined, "root 外では一覧を返さない");
  }
});

test("files endpoint reports missing paths and non-directories", async () => {
  const root = await createListingRoot("pi-sbx-files-errors-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const missing = await listFiles(service.app, "nope/deeper");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error ?? "", /Path not found/);

  const notDirectory = await listFiles(service.app, "A.txt");
  assert.equal(notDirectory.status, 400);
  assert.match(notDirectory.body.error ?? "", /Not a directory/);
});

test("files endpoint truncates at the entry limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-files-limit-"));
  const total = SANDBOX_MAX_FILE_ENTRIES + 5;
  for (let index = 0; index < total; index += 1) {
    // 桁数を揃えて名前順も確認できるようにする
    await writeFile(join(root, `f${String(index).padStart(4, "0")}.txt`), "x", "utf8");
  }
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const listing = await listFiles(service.app);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.entries.length, SANDBOX_MAX_FILE_ENTRIES);
  assert.equal(listing.body.truncated, true);
  assert.equal(listing.body.entries[0].name, "f0000.txt");
  assert.equal(listing.body.entries.at(-1)?.name, `f${String(SANDBOX_MAX_FILE_ENTRIES - 1).padStart(4, "0")}.txt`);
});

test("files endpoint distinguishes symlinks and only opens targets inside the root", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = await createListingRoot("pi-sbx-files-symlink-");
  const outside = await createListingRoot("pi-sbx-files-outside-");
  await symlink(join(root, "dirB"), join(root, "linkInside"));
  await symlink(join(root, "A.txt"), join(root, "linkFile"));
  await symlink(outside, join(root, "linkOutside"));
  await symlink(join(root, "gone.txt"), join(root, "linkBroken"));

  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const listing = await listFiles(service.app);
  assert.equal(listing.status, 200);
  const byName = new Map(listing.body.entries.map((entry) => [entry.name, entry]));
  // type は辿った先の実体種別、symlink で区別する
  assert.deepEqual(
    [byName.get("linkInside")?.type, byName.get("linkInside")?.symlink],
    ["dir", true],
  );
  assert.deepEqual([byName.get("linkFile")?.type, byName.get("linkFile")?.symlink], ["file", true]);
  assert.deepEqual([byName.get("linkOutside")?.type, byName.get("linkOutside")?.symlink], ["dir", true]);
  assert.deepEqual([byName.get("linkBroken")?.type, byName.get("linkBroken")?.symlink], ["file", true]);
  // 一覧は symlink の指す先を列挙しない (root 配下だけ)
  assert.deepEqual(
    listing.body.entries.map((entry) => entry.name).filter((name) => name.startsWith("outside-")),
    [],
  );
  // symlink にも size / mtime を付ける (壊れたリンクは付けない)
  assert.equal(typeof byName.get("linkFile")?.size, "number");
  assert.equal(byName.get("linkBroken")?.size, undefined);

  // root 内を指す symlink は普通に開ける (path は解決後の実ディレクトリを root 相対で返す)
  const inside = await listFiles(service.app, "linkInside");
  assert.equal(inside.status, 200);
  assert.equal(inside.body.path, "dirB");
  assert.deepEqual(
    inside.body.entries.map((entry) => entry.name),
    ["nested"],
  );

  // root 外を指す symlink は 400 (一覧には出るが開けない)
  const outsideOpen = await listFiles(service.app, "linkOutside");
  assert.equal(outsideOpen.status, 400);
  assert.match(outsideOpen.body.error ?? "", /outside the workspace/);
});

test(
  "files endpoint judges the root boundary by the resolved path, even when the request starts outside the root",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    // root の外に root を指す symlink を置き、lexical には root 外でも realpath が root 内へ戻る要求を再現する
    // (実行環境依存のパスは使わない)
    const base = mkdtempSync(join(tmpdir(), "pi-sbx-files-alias-"));
    const root = join(base, "root");
    await mkdir(join(root, "dirB"), { recursive: true });
    await writeFile(join(root, "A.txt"), "a", "utf8");
    await mkdir(join(base, "outside"), { recursive: true });
    await symlink(root, join(base, "link-in"));

    const service = createSandboxService({ token: TOKEN, rootCwd: root });

    // `..` を含んでいても、解決後の実パスが root 内なら 200
    const relative = await listFiles(service.app, "../link-in");
    assert.equal(relative.status, 200, relative.body.error ?? "");
    assert.equal(relative.body.path, ".");
    assert.deepEqual(
      relative.body.entries.map((entry) => entry.name),
      ["dirB", "A.txt"],
    );

    // 絶対パスで root 外の symlink を指す場合も同じ (判定は lexical な位置ではなく解決後の実パス)
    const absolute = await listFiles(service.app, join(base, "link-in", "dirB"));
    assert.equal(absolute.status, 200, absolute.body.error ?? "");
    assert.equal(absolute.body.path, "dirB");

    // 実在する root 外のディレクトリは 400 のまま (解決後の実パスが root 外)
    const outside = await listFiles(service.app, "../outside");
    assert.equal(outside.status, 400);
    assert.match(outside.body.error ?? "", /outside the workspace/);

    // 実在しない要求は lexical な位置で判定する: root 外 → 400 (404 にしない)、root 内 → 404
    const missingOutside = await listFiles(service.app, "../missing");
    assert.equal(missingOutside.status, 400, "root 外を指す未作成パスは入力検証として 400 のまま");
    assert.match(missingOutside.body.error ?? "", /outside the workspace/);

    const missingInside = await listFiles(service.app, "missing");
    assert.equal(missingInside.status, 404);
    assert.match(missingInside.body.error ?? "", /Path not found/);
  },
);

test(
  "files endpoint applies .. after following symlinks, like the kernel walk",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    // `..` は symlink を辿った後に適用される。字句的に畳んでから realpath にかけると、ここが両方向にずれる。
    const base = mkdtempSync(join(tmpdir(), "pi-sbx-files-dotdot-"));
    const root = join(base, "root");
    await mkdir(join(root, "dirB", "nested"), { recursive: true });
    await mkdir(join(base, "outside", "nested"), { recursive: true });
    await writeFile(join(root, "A.txt"), "a", "utf8");
    await writeFile(join(base, "outside", "outer.txt"), "o", "utf8");
    // root 内から root 外を指す symlink と、root 外から root 内を指す symlink
    await symlink(join(base, "outside", "nested"), join(root, "linkOutside"));
    await symlink(join(root, "dirB"), join(base, "outside", "link-in"));

    const service = createSandboxService({ token: TOKEN, rootCwd: root });

    // root/linkOutside -> outside/nested なので、linkOutside/.. は outside (root 外) へ解決する
    const escape = await listFiles(service.app, "linkOutside/..");
    assert.equal(escape.status, 400, "'..' must apply to the resolved target, not lexically");
    assert.match(escape.body.error ?? "", /outside the workspace/);
    assert.equal((await listFiles(service.app, "linkOutside/../nested")).status, 400);

    // outside/link-in -> root/dirB なので、../outside/link-in/.. は root へ解決する
    const back = await listFiles(service.app, "../outside/link-in/..");
    assert.equal(back.status, 200, back.body.error ?? "");
    assert.equal(back.body.path, ".");
    assert.deepEqual(
      back.body.entries.map((entry) => entry.name),
      ["dirB", "linkOutside", "A.txt"],
    );

    // root 外の symlink 経由でも、解決後の実ディレクトリが root 内なら開ける
    const nested = await listFiles(service.app, "../outside/link-in/nested");
    assert.equal(nested.status, 200, nested.body.error ?? "");
    assert.equal(nested.body.path, "dirB/nested");
    assert.deepEqual(nested.body.entries, []);
  },
);
