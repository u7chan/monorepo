// listen せず app.request() で検証する。SDK のローカルツール実装と実ファイルシステム / bash だけを使い、実 LLM API は呼ばない。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSandboxService } from "../src/sandbox/service";
import {
  SANDBOX_MAX_FILE_ENTRIES,
  type SandboxErrorEvent,
  type SandboxEvent,
  type SandboxFileListing,
} from "../src/sandbox/protocol";

const TOKEN = "test-sandbox-token-0123456789abcdef";
const HAS_BASH = existsSync("/bin/bash");
const SKIP_REASON = "bash is not available on this platform";
const HAS_FD = (() => {
  for (const name of ["fd", "fdfind"]) {
    const probe = spawnSync(name, ["--version"], { stdio: "pipe" });
    if (!probe.error && probe.status === 0) return true;
  }
  return false;
})();
// fd が無いと SDK の find ツールがリリースバイナリを取りに行く。実行環境に fd があるときだけ回す
const FD_SKIP_REASON = "fd is not available";
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

/** POST /v1/tools/:tool/execute の NDJSON と、非 200 の JSON エラーを扱うヘルパ */
async function executeTool(
  app: ReturnType<typeof createSandboxService>["app"],
  tool: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SandboxEvent[]; error?: string }> {
  const response = await app.request(`/v1/tools/${tool}/execute`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    const parsed = (await response.json()) as { error?: string };
    return { status: response.status, events: [], error: parsed.error };
  }
  return { status: 200, events: await readEvents(response) };
}

/** POST /v1/dirs のヘルパ (JSON 応答) */
async function createDir(
  app: ReturnType<typeof createSandboxService>["app"],
  path: unknown,
): Promise<{ status: number; body: { path?: string; error?: string } }> {
  const response = await app.request("/v1/dirs", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ path }),
  });
  return { status: response.status, body: (await response.json()) as { path?: string; error?: string } };
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
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
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
  assert.ok(
    events.some((event) => event.type === "result"),
    "write should succeed",
  );
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
  const cancelled = await service.app.request(`/v1/executions/${start.executionId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
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

test(
  "sandbox bash does not expose the shared token or session env to child processes",
  { skip: !HAS_BASH && SKIP_REASON },
  async () => {
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
            command: 'if [ -n "$PI_SANDBOX_TOKEN" ]; then echo TOKEN_LEAKED; fi; echo session=${PI_SESSION_ID:-unset}',
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
  },
);

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

test("tool execution resolves relative paths against the requested cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-exec-cwd-"));
  await mkdir(join(root, "sub"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const written = await executeTool(service.app, "write", {
    params: { path: "note.txt", content: "from sub" },
    cwd: "sub",
  });
  assert.equal(written.status, 200);
  assert.ok(
    written.events.some((event) => event.type === "result"),
    "write with cwd should succeed",
  );
  assert.equal(await readFile(join(root, "sub", "note.txt"), "utf8"), "from sub");

  const read = await executeTool(service.app, "read", { params: { path: "note.txt" }, cwd: "sub" });
  const result = read.events.find((event) => event.type === "result");
  assert.ok(result, "read with cwd should succeed");
  assert.match(eventText((result as { payload: unknown }).payload), /from sub/);

  // 同じ相対パスでも root を起点にすれば別の場所になる
  const fromRoot = await executeTool(service.app, "read", { params: { path: "note.txt" } });
  assert.ok(
    fromRoot.events.some((event) => event.type === "error"),
    "root has no note.txt",
  );
});

test("executes find outside a git repository", { skip: !HAS_FD && FD_SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-find-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "", "utf8");
  await writeFile(join(root, "README.md"), "", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  // fd に --no-require-git を渡す経路なので、git 管理外 (tmpdir) で検索できないと失敗する
  const found = await executeTool(service.app, "find", { params: { pattern: "*.ts", path: "." } });
  const result = found.events.find((event) => event.type === "result");
  assert.ok(result, "find outside a git repository should succeed");
  assert.match(eventText((result as { payload: unknown }).payload), /src\/app\.ts/);
});

test("tool execution rejects a cwd outside the workspace or not a directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-exec-cwd-bad-"));
  await writeFile(join(root, "file.txt"), "x", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const outside = await executeTool(service.app, "ls", { params: {}, cwd: "../outside" });
  assert.equal(outside.status, 400);
  assert.match(outside.error ?? "", /outside the workspace/);
  assert.equal((await executeTool(service.app, "ls", { params: {}, cwd: "/" })).status, 400);
  assert.equal((await executeTool(service.app, "ls", { params: {}, cwd: "missing" })).status, 404);

  const notDirectory = await executeTool(service.app, "ls", { params: {}, cwd: "file.txt" });
  assert.equal(notDirectory.status, 400);
  assert.match(notDirectory.error ?? "", /Not a directory/);

  assert.equal((await executeTool(service.app, "ls", { params: {}, cwd: 42 })).status, 400);
  // cwd 省略時の root は今までどおり
  assert.equal((await executeTool(service.app, "ls", { params: {} })).status, 200);
});

// ---------------------------------------------------------------------------
// write / edit の書き込み範囲 (セッションの作業ディレクトリ)
// ---------------------------------------------------------------------------

/** 未所属セッション相当の workdir (`.u7agent/sessions/<id>`) と root を作る */
async function createScopeRoot(prefix: string): Promise<{ root: string; scratch: string }> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const scratch = ".u7agent/sessions/aaaa111111";
  await mkdir(join(root, scratch), { recursive: true });
  return { root, scratch };
}

function errorEvent(events: SandboxEvent[]): SandboxErrorEvent | undefined {
  return events.find((event): event is SandboxErrorEvent => event.type === "error");
}

test("write / edit は実行 cwd の外を拒否し、許可場所と再試行例を返す", async () => {
  const { root, scratch } = await createScopeRoot("pi-sbx-write-scope-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const workdir = join(root, scratch);

  // モデルがやりがちな取り違え (workspace root を指す絶対パス)
  const denied = await executeTool(service.app, "write", {
    params: { path: join(root, "cafe.html"), content: "x" },
    cwd: scratch,
  });
  assert.equal(denied.status, 200, "拒否は 400 ではなく error イベントで返す");
  const error = errorEvent(denied.events);
  assert.ok(error, "error イベントが返る");
  assert.match(error.message, /Cannot write or edit outside/);
  assert.ok(error.message.includes(workdir), error.message);
  assert.ok(error.message.includes(join(root, ".agents", "skills")), error.message);
  assert.match(error.message, /`cafe\.html`/);
  assert.equal(existsSync(join(root, "cafe.html")), false, "workdir 外には書かない");

  // cwd 相対で再試行するとスクラッチに作られる
  const retried = await executeTool(service.app, "write", {
    params: { path: "cafe.html", content: "made" },
    cwd: scratch,
  });
  assert.equal(retried.status, 200);
  assert.ok(retried.events.some((event) => event.type === "result"));
  assert.equal(await readFile(join(root, scratch, "cafe.html"), "utf8"), "made");
});

test("拒否された write は workdir 外の親ディレクトリも作らない", async () => {
  const { root, scratch } = await createScopeRoot("pi-sbx-write-mkdir-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const absolute = await executeTool(service.app, "write", {
    params: { path: join(root, "outside/nested/new.txt"), content: "x" },
    cwd: scratch,
  });
  assert.ok(errorEvent(absolute.events), "root 直下の未作成ツリーは拒否する");
  assert.equal(existsSync(join(root, "outside")), false, "mkdir はポリシー判定を通ってから行う");

  // `..` で workdir を出る相対パスも同じ (`.u7agent/outside` はスクラッチの外)
  const traversal = await executeTool(service.app, "write", {
    params: { path: "../../outside/nested/new.txt", content: "x" },
    cwd: scratch,
  });
  assert.ok(errorEvent(traversal.events), "`..` で workdir を出るパスは拒否する");
  assert.equal(existsSync(join(root, ".u7agent", "outside")), false);
});

test("SDK の特殊なパス形 (絶対 / ~ / file:// / @) も作業ディレクトリの外なら拒否する", async () => {
  const { root, scratch } = await createScopeRoot("pi-sbx-write-forms-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  for (const requested of [
    join(root, "cafe.html"),
    "/etc/u7agent-scope-test",
    "~/u7agent-scope-test",
    "file:///etc/u7agent-scope-test",
    `@${join(root, "cafe.html")}`,
  ]) {
    const denied = await executeTool(service.app, "write", { params: { path: requested, content: "x" }, cwd: scratch });
    assert.equal(denied.status, 200, requested);
    const error = errorEvent(denied.events);
    assert.ok(error, requested);
    assert.match(error.message, /Cannot write or edit outside/, requested);
  }
  assert.equal(existsSync(join(root, "cafe.html")), false);
});

test("edit のポリシー拒否は実在しないパスでも文言を保つ", async () => {
  const { root, scratch } = await createScopeRoot("pi-sbx-edit-scope-");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  // 実在しないパスでも access の ENOENT ではなくポリシーの文言を返す (SDK は access の失敗に前置きするだけ)
  const denied = await executeTool(service.app, "edit", {
    params: { path: join(root, "missing.txt"), edits: [{ oldText: "a", newText: "b" }] },
    cwd: scratch,
  });
  assert.equal(denied.status, 200);
  const error = errorEvent(denied.events);
  assert.ok(error);
  assert.match(error.message, /^Could not edit file: /);
  assert.match(error.message, /Cannot write or edit outside/);
  assert.doesNotMatch(error.message, /Error code:/, "code を付けると SDK が文言を置き換える");
  assert.ok(error.message.includes(join(root, scratch)), error.message);
  assert.ok(error.message.includes(join(root, ".agents", "skills")), error.message);
});

test("プロジェクト所属セッションは登録ディレクトリの外を拒否する", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-write-project-"));
  await mkdir(join(root, "projA"));
  await mkdir(join(root, "projB"));
  await writeFile(join(root, "projB", "note.txt"), "keep", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const ok = await executeTool(service.app, "write", { params: { path: "ok.txt", content: "a" }, cwd: "projA" });
  assert.ok(ok.events.some((event) => event.type === "result"));
  assert.equal(await readFile(join(root, "projA", "ok.txt"), "utf8"), "a");

  for (const [tool, params] of [
    ["write", { path: "../projB/other.txt", content: "x" }],
    ["write", { path: join(root, "projB", "other.txt"), content: "x" }],
    ["write", { path: join(root, "root-level.txt"), content: "x" }],
    ["edit", { path: "../projB/note.txt", edits: [{ oldText: "keep", newText: "changed" }] }],
  ] as const) {
    const denied = await executeTool(service.app, tool, { params, cwd: "projA" });
    assert.equal(denied.status, 200, `${tool} ${JSON.stringify(params)}`);
    assert.ok(errorEvent(denied.events), `${tool} ${JSON.stringify(params)}`);
  }
  assert.equal(await readFile(join(root, "projB", "note.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(root, "projB", "other.txt")), false);
  assert.equal(existsSync(join(root, "root-level.txt")), false);

  // workdir 内の絶対パスは従来どおり通る
  const absolute = await executeTool(service.app, "write", {
    params: { path: join(root, "projA", "abs.txt"), content: "b" },
    cwd: "projA",
  });
  assert.ok(absolute.events.some((event) => event.type === "result"));
  assert.equal(await readFile(join(root, "projA", "abs.txt"), "utf8"), "b");
});

test("共通スキル置き場への write / edit は未所属・所属の両方で通る", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-write-skills-"));
  const scratch = ".u7agent/sessions/cccc333333";
  await mkdir(join(root, scratch), { recursive: true });
  await mkdir(join(root, "proj"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });
  const skillPath = join(root, ".agents", "skills", "demo", "SKILL.md");

  for (const cwd of [scratch, "proj"]) {
    // .agents/skills が未作成でも mkdir ごと通る
    const written = await executeTool(service.app, "write", {
      params: { path: skillPath, content: "---\nname: demo\n---\nbody\n" },
      cwd,
    });
    assert.ok(
      written.events.some((event) => event.type === "result"),
      cwd,
    );
    const edited = await executeTool(service.app, "edit", {
      params: { path: skillPath, edits: [{ oldText: "body", newText: "changed" }] },
      cwd,
    });
    assert.ok(
      edited.events.some((event) => event.type === "result"),
      cwd,
    );
  }
  assert.match(await readFile(skillPath, "utf8"), /changed/);
});

test("永続化なしの未所属 (作業ディレクトリ = root) は root 直下に書ける", async () => {
  // `PI_SESSION_STORE` なしの縮退では workdirOf が root を返すため、境界は workspace root だけになる
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-write-root-cwd-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-sbx-write-root-outside-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const allowed = await executeTool(service.app, "write", { params: { path: "cafe.html", content: "root" } });
  assert.ok(allowed.events.some((event) => event.type === "result"));
  assert.equal(await readFile(join(root, "cafe.html"), "utf8"), "root");

  for (const requested of [
    join(outside, "x.txt"),
    "/etc/u7agent-scope-test",
    "~/u7agent-scope-test",
    "file:///etc/u7agent-scope-test",
  ]) {
    const denied = await executeTool(service.app, "write", { params: { path: requested, content: "x" } });
    assert.equal(denied.status, 200, requested);
    assert.ok(errorEvent(denied.events), requested);
  }
  assert.equal(existsSync(join(outside, "x.txt")), false);
});

test("添付・他セッションのスクラッチ・builtin-skills は write / edit を拒否し、read は通す", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-write-external-"));
  const scratch = ".u7agent/sessions/dddd444444";
  const other = ".u7agent/sessions/eeee555555";
  const uploads = ".u7agent/uploads/dddd444444";
  const builtin = ".u7agent/builtin-skills/demo";
  for (const dir of [scratch, other, uploads, builtin]) await mkdir(join(root, dir), { recursive: true });
  const attachment = join(root, uploads, "memo.txt");
  await writeFile(attachment, "attached-body", "utf8");
  const skillFile = join(root, builtin, "SKILL.md");
  await writeFile(skillFile, "builtin-body", "utf8");
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  for (const [tool, params] of [
    ["write", { path: attachment, content: "x" }],
    ["edit", { path: attachment, edits: [{ oldText: "attached-body", newText: "x" }] }],
    ["write", { path: join(root, other, "new.txt"), content: "x" }],
    ["edit", { path: skillFile, edits: [{ oldText: "builtin-body", newText: "x" }] }],
  ] as const) {
    const denied = await executeTool(service.app, tool, { params, cwd: scratch });
    assert.equal(denied.status, 200, tool);
    assert.ok(errorEvent(denied.events), tool);
  }
  assert.equal(await readFile(attachment, "utf8"), "attached-body", "拒否された edit はファイルを変えない");
  assert.equal(await readFile(skillFile, "utf8"), "builtin-body");

  // read は絞らない: 添付も実体のある組み込みスキルも読める
  const read = await executeTool(service.app, "read", { params: { path: attachment }, cwd: scratch });
  const result = read.events.find((event) => event.type === "result");
  assert.ok(result, "添付は read できる");
  assert.match(eventText((result as { payload: unknown }).payload), /attached-body/);
});

test(
  "workspace root が symlink でも lexical な絶対パスへ書ける",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-sbx-write-link-root-"));
    const real = join(base, "real");
    await mkdir(real, { recursive: true });
    const link = join(base, "link");
    await symlink(real, link);
    const service = createSandboxService({ token: TOKEN, rootCwd: link });

    // 相対パスは実行 cwd (realpath)、system prompt に出る symlink 形の絶対パスは lexical な root で通す
    const relative = await executeTool(service.app, "write", { params: { path: "relative.txt", content: "a" } });
    assert.ok(relative.events.some((event) => event.type === "result"));
    assert.equal(await readFile(join(real, "relative.txt"), "utf8"), "a");

    const absolute = await executeTool(service.app, "write", {
      params: { path: join(link, "absolute.txt"), content: "b" },
    });
    assert.ok(absolute.events.some((event) => event.type === "result"));
    assert.equal(await readFile(join(real, "absolute.txt"), "utf8"), "b");

    // 既存ファイルの edit も両方の形で通る
    for (const path of [join(link, "relative.txt"), join(real, "absolute.txt")]) {
      const edited = await executeTool(service.app, "edit", {
        params: { path, edits: [{ oldText: path.includes("relative") ? "a" : "b", newText: "edited" }] },
      });
      assert.ok(
        edited.events.some((event) => event.type === "result"),
        path,
      );
    }
    assert.equal(await readFile(join(real, "relative.txt"), "utf8"), "edited");
    assert.equal(await readFile(join(real, "absolute.txt"), "utf8"), "edited");
  },
);

test(
  "登録プロジェクトが symlink でも lexical な絶対パスへ書ける",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-write-link-project-"));
    await mkdir(join(root, "real-proj"));
    await writeFile(join(root, "real-proj", "existing.txt"), "before", "utf8");
    await symlink(join(root, "real-proj"), join(root, "proj"));
    const service = createSandboxService({ token: TOKEN, rootCwd: root });

    for (const requested of [
      "relative.txt",
      join(root, "proj", "link-form.txt"),
      join(root, "real-proj", "real-form.txt"),
    ]) {
      const written = await executeTool(service.app, "write", {
        params: { path: requested, content: "ok" },
        cwd: "proj",
      });
      assert.ok(
        written.events.some((event) => event.type === "result"),
        requested,
      );
    }
    for (const requested of ["existing.txt", join(root, "proj", "relative.txt")]) {
      const edited = await executeTool(service.app, "edit", {
        params: {
          path: requested,
          edits: [{ oldText: requested === "existing.txt" ? "before" : "ok", newText: "after" }],
        },
        cwd: "proj",
      });
      assert.ok(
        edited.events.some((event) => event.type === "result"),
        requested,
      );
    }
    assert.equal(await readFile(join(root, "real-proj", "relative.txt"), "utf8"), "after");
    assert.equal(await readFile(join(root, "real-proj", "existing.txt"), "utf8"), "after");
  },
);

test("dirs endpoint creates nested directories and treats an existing one as success", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-dirs-"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const created = await createDir(service.app, "a/b/c");
  assert.equal(created.status, 200);
  assert.equal(created.body.path, "a/b/c");
  assert.equal(existsSync(join(root, "a", "b", "c")), true);

  const again = await createDir(service.app, "a/b/c");
  assert.equal(again.status, 200, "既存ディレクトリは成功扱い");
  assert.equal(again.body.path, "a/b/c");

  // 末尾スラッシュや "." は正規化して同じ場所を指す
  assert.equal((await createDir(service.app, "./a//b/c/")).body.path, "a/b/c");
  // 未認証は 401
  assert.equal((await service.app.request("/v1/dirs", { method: "POST" })).status, 401);
  // body の形が違う場合は 400
  assert.equal((await createDir(service.app, 42)).status, 400);
});

test("dirs endpoint rejects a path outside the workspace", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-dirs-escape-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-sbx-dirs-outside-"));
  await writeFile(join(root, "file.txt"), "x", "utf8");
  await symlink(outside, join(root, "linkOutside"));
  const service = createSandboxService({ token: TOKEN, rootCwd: root });

  const traversal = await createDir(service.app, "../outside");
  assert.equal(traversal.status, 400);
  assert.match(traversal.body.error ?? "", /outside the workspace/);
  assert.equal((await createDir(service.app, "/absolute")).status, 400);

  // 既存の symlink が root 外を指す場合も、その先にディレクトリを作らない
  const escape = await createDir(service.app, "linkOutside/new");
  assert.equal(escape.status, 400);
  assert.equal(existsSync(join(outside, "new")), false);

  // 既存ファイルと同名のディレクトリは作れない
  const onFile = await createDir(service.app, "file.txt/nested");
  assert.equal(onFile.status, 400);
  assert.equal((await createDir(service.app, "file.txt")).status, 400);
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
  // ファイルには size も mtime も付き、ディレクトリには mtime だけが付く (size は内容量を表さない)
  const file = rootListing.body.entries.find((entry) => entry.name === "A.txt");
  assert.equal(file?.size, 1);
  assert.equal(typeof file?.mtime, "number");
  assert.ok((file?.mtime ?? 0) > 0);
  const directory = rootListing.body.entries.find((entry) => entry.name === "dirB");
  assert.equal(directory?.size, undefined);
  assert.equal(directory?.mtime, Math.round(lstatSync(join(root, "dirB")).mtimeMs));
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

test(
  "files endpoint distinguishes symlinks and only opens targets inside the root",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
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
    assert.deepEqual([byName.get("linkInside")?.type, byName.get("linkInside")?.symlink], ["dir", true]);
    assert.deepEqual([byName.get("linkFile")?.type, byName.get("linkFile")?.symlink], ["file", true]);
    assert.deepEqual([byName.get("linkOutside")?.type, byName.get("linkOutside")?.symlink], ["dir", true]);
    assert.deepEqual([byName.get("linkBroken")?.type, byName.get("linkBroken")?.symlink], ["file", true]);
    // 一覧は symlink の指す先を列挙しない (root 配下だけ)
    assert.deepEqual(
      listing.body.entries.map((entry) => entry.name).filter((name) => name.startsWith("outside-")),
      [],
    );
    // symlink にも size / mtime を付ける (dir symlink の mtime はリンク先の値で、壊れたリンクには付けない)
    assert.equal(typeof byName.get("linkFile")?.size, "number");
    assert.equal(byName.get("linkBroken")?.size, undefined);
    assert.equal(byName.get("linkBroken")?.mtime, undefined);
    assert.equal(byName.get("linkInside")?.size, undefined);
    assert.equal(byName.get("linkInside")?.mtime, Math.round(lstatSync(join(root, "dirB")).mtimeMs));

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
  },
);

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
