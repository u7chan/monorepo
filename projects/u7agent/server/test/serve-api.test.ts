// serve (サービス) の HTTP 契約とツール配線。サンドボックスはスクリプトを解釈するスタブへ差し替える。
//   - 状態 / 起動 / 停止の応答が ServeStatusSchema を満たす
//   - 403 (他会話の所有者) / 409 (照合不一致) / 400 / 404 / 502 / 503 の分岐
//   - serve ツールは BFF ローカルの customTool として登録され、サンドボックスへは送られない
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { createSecretMasker } from "../src/redact";
import { RuntimeServeStatusSchema, ServeStatusSchema } from "../src/schema";
import { UnknownRemoteToolError, createRemoteToolDefinitions } from "../src/sandbox/remote-tools";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox/service";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { createServeToolDefinitions, createServeToolHost, withServeTool } from "../src/serve-tool";
import { createServeSandboxStub } from "./serve-stub";
import { asPiBff, createStubPi } from "./stub-pi";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const workspace: SandboxWorkspaceClient = {
  previewFile: async () => ({ text: "" }),
  listFiles: async (path: string) => ({ path: path || ".", entries: [], truncated: false }),
  // git 情報はこのテストでは扱わない
  getGitInfo: async () => ({ branch: null }),
  listSkills: async () => ({ skills: [] }),
  createDir: async (path: string) => ({ path }),
  renameEntry: async (path: string, name: string) => ({ path, name }),
  deleteFile: async () => {},
  deleteDirectory: async () => {},
  uploadFile: async ({ name }) => ({ path: `uploads/${name}`, name, renamed: false, size: 0 }),
  rawFile: async () => ({ status: 200, contentType: "image/png", body: null }),
  downloadEntry: async () => ({
    contentType: "application/octet-stream",
    contentDisposition: "attachment",
    body: null,
  }),
  checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
};

/** セッションを 2 つ作る (未所属なので cwd は root = "")。実績は root の作業ディレクトリに置く */
async function setup() {
  const sandbox = createServeSandboxStub();
  const pi = createStubPi();
  const bff = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: asPiBff(pi),
    workspace,
    serveSandbox: sandbox.sandbox,
    // 稼働判定は待受プロセスの有無 (起動で listen が始まり、停止で消える)
    serveProbe: async () => sandbox.state.listener !== null,
  });
  const first = (await jsonBody(await bff.app.request("/api/sessions", jsonPost({})))) as { sessionId: string };
  const second = (await jsonBody(await bff.app.request("/api/sessions", jsonPost({})))) as { sessionId: string };
  bff.appDb.saveServeCommand({ cwd: "", command: "pnpm dev", updatedAt: 1 });
  return { bff, sandbox, pi, first: first.sessionId, second: second.sessionId };
}

test("ランタイムは会話未選択でも全体の状態を取得し、所有者のサービスを停止できる", async () => {
  const { bff, sandbox, first } = await setup();
  try {
    const initial = await jsonBody(await bff.app.request("/api/serve/runtime/status"));
    assert.deepEqual(initial, { reachable: false, owner: null, generation: null, command: null });
    await bff.app.request("/api/serve/start", jsonPost({ sessionId: first }));
    const status = await jsonBody(await bff.app.request("/api/serve/runtime/status"));
    assert.equal(RuntimeServeStatusSchema.safeParse(status).success, true);
    assert.deepEqual(status.owner, { sessionId: first, title: "無題のセッション" });
    assert.deepEqual(status.command, { cwd: "", command: "pnpm dev" });
    const conflict = await bff.app.request("/api/serve/runtime/stop", jsonPost({ generation: "stale" }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(sandbox.state.killed, []);
    for (const body of [
      {},
      { generation: null },
      { generation: "" },
      { generation: status.generation, sessionId: first },
    ]) {
      assert.equal((await bff.app.request("/api/serve/runtime/stop", jsonPost(body))).status, 400);
    }
    const csrf = await bff.app.request("http://app.test/api/serve/runtime/stop", {
      ...jsonPost({ generation: status.generation }),
      headers: { Origin: "http://evil.test", "Content-Type": "application/json" },
    });
    assert.equal(csrf.status, 403);
    assert.deepEqual(sandbox.state.killed, []);
    const stopped = await bff.app.request("/api/serve/runtime/stop", jsonPost({ generation: status.generation }));
    assert.equal(stopped.status, 200);
    assert.deepEqual(await jsonBody(stopped), initial);
    assert.equal(sandbox.state.killed.length, 1);
  } finally {
    await bff.close();
  }
});

test("GET /api/serve/status は閲覧中の会話から見た状態を返す", async () => {
  const { bff, first } = await setup();
  try {
    const stopped = await jsonBody(await bff.app.request(`/api/serve/status?sessionId=${first}`));
    assert.equal(ServeStatusSchema.safeParse(stopped).success, true);
    assert.deepEqual(stopped, {
      reachable: false,
      owner: { kind: "none" },
      generation: null,
      command: { cwd: "", command: "pnpm dev" },
      // 環境変数の解決源を渡していないので世代は常に空 (記録は起動時に解決した値を持つ)
      secretGeneration: null,
    });

    const started = await jsonBody(await bff.app.request("/api/serve/start", jsonPost({ sessionId: first })));
    assert.equal(started.reachable, true);
    assert.equal(started.owner.kind, "mine");
    assert.equal(typeof started.generation, "string");
    assert.equal(ServeStatusSchema.safeParse(started).success, true);

    // 状態 API も同じ値になる (押した時点で確定する)
    const status = await jsonBody(await bff.app.request(`/api/serve/status?sessionId=${first}`));
    assert.deepEqual(status, started);

    const stoppedAgain = await jsonBody(
      await bff.app.request("/api/serve/stop", jsonPost({ sessionId: first, generation: started.generation })),
    );
    assert.equal(stoppedAgain.reachable, false);
    assert.equal(stoppedAgain.generation, null);
  } finally {
    await bff.close();
  }
});

test("他会話の所有者は 403、照合不一致は 409 にする", async () => {
  const { bff, first, second } = await setup();
  try {
    const started = await jsonBody(await bff.app.request("/api/serve/start", jsonPost({ sessionId: first })));
    // 閲覧中の会話から見れば他会話が公開中 (起動の実績はあるので操作は出る)
    const seen = await jsonBody(await bff.app.request(`/api/serve/status?sessionId=${second}`));
    assert.deepEqual(seen.owner, { kind: "other", title: "無題のセッション" });

    const forbidden = await bff.app.request(
      "/api/serve/stop",
      jsonPost({ sessionId: second, generation: started.generation }),
    );
    assert.equal(forbidden.status, 403);
    assert.match((await jsonBody(forbidden)).error, /公開しています/);

    // 古い世代で置き換えようとすると 409 (UI は最新の状態で確認をやり直す)
    const conflict = await bff.app.request(
      "/api/serve/start",
      jsonPost({ sessionId: second, generation: "old-generation" }),
    );
    assert.equal(conflict.status, 409);
    assert.match((await jsonBody(conflict)).error, /確認し直してください/);
  } finally {
    await bff.close();
  }
});

test("sessionId の欠落・不正な body・未知の会話を区別して返す", async () => {
  const { bff } = await setup();
  try {
    assert.equal((await bff.app.request("/api/serve/status")).status, 400);
    assert.equal((await bff.app.request("/api/serve/status?sessionId=%20")).status, 400);
    assert.equal((await bff.app.request("/api/serve/status?sessionId=unknown000")).status, 404);
    assert.equal((await bff.app.request("/api/serve/start", jsonPost({}))).status, 400);
    assert.equal((await bff.app.request("/api/serve/start", jsonPost({ sessionId: "unknown000" }))).status, 404);
    assert.equal((await bff.app.request("/api/serve/stop", jsonPost({ sessionId: "" }))).status, 400);
  } finally {
    await bff.close();
  }
});

test("サンドボックス未設定は 503、プローブの失敗は 502 にする", async () => {
  const pi = createStubPi();
  const unconfigured = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: asPiBff(pi),
    workspace,
    serveSandbox: null,
    serveProbe: async () => true,
  });
  try {
    const created = (await jsonBody(await unconfigured.app.request("/api/sessions", jsonPost({})))) as {
      sessionId: string;
    };
    const response = await unconfigured.app.request(`/api/serve/status?sessionId=${created.sessionId}`);
    assert.equal(response.status, 503);
    assert.equal((await unconfigured.app.request("/api/serve/runtime/status")).status, 503);
    assert.equal(
      (await unconfigured.app.request("/api/serve/runtime/stop", jsonPost({ generation: "g" }))).status,
      503,
    );
    assert.match((await jsonBody(response)).error, /PI_SANDBOX_URL/);
    assert.equal(pi.serveHosts.at(-1)?.configured, false, "未設定ではツールを公開しない");
  } finally {
    await unconfigured.close();
  }

  const failing = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace,
    serveSandbox: createServeSandboxStub().sandbox,
    // 名前解決できない = BFF からサンドボックスへ届かない障害 (到達不可へ丸めない)
    serveProbe: async () => {
      const error = new Error("サンドボックス (sandbox:8080) へ接続できません: getaddrinfo ENOTFOUND") as Error & {
        statusCode?: number;
      };
      error.statusCode = 502;
      throw error;
    },
  });
  try {
    const created = (await jsonBody(await failing.app.request("/api/sessions", jsonPost({})))) as {
      sessionId: string;
    };
    const response = await failing.app.request(`/api/serve/status?sessionId=${created.sessionId}`);
    assert.equal(response.status, 502);
    assert.equal((await failing.app.request("/api/serve/runtime/status")).status, 502);
    assert.equal((await failing.app.request("/api/serve/runtime/stop", jsonPost({ generation: "g" }))).status, 502);
    assert.match((await jsonBody(response)).error, /接続できません/);
  } finally {
    await failing.close();
  }
});

test("アプリデータが使えないときは serve の API も 503 にする", async () => {
  const cwd = "/tmp/project";
  const previous = process.env.PI_SESSION_STORE;
  process.env.PI_SESSION_STORE = join(cwd, "inside-workspace");
  const bff = await createBffApp({ cwd, pi: null, workspace: null });
  if (previous === undefined) delete process.env.PI_SESSION_STORE;
  else process.env.PI_SESSION_STORE = previous;
  try {
    assert.equal(bff.appDb.status().ok, false);
    const status = await bff.app.request("/api/serve/status?sessionId=aaaa000001");
    assert.equal(status.status, 503);
    // 読み取りは 503 だけ、変更系は「何も保存していない」ことを state でも示す
    assert.equal((await jsonBody(status)).state, undefined);
    for (const path of ["/api/serve/start", "/api/serve/stop"]) {
      const response = await bff.app.request(path, jsonPost({ sessionId: "aaaa000001" }));
      assert.equal(response.status, 503, path);
      assert.equal((await jsonBody(response)).state, "not_stored", path);
    }
  } finally {
    await bff.close();
  }
});

test("serve ツールは会話へ束縛した BFF ローカルの customTool として登録する", async () => {
  const { bff, pi, first } = await setup();
  try {
    // 実体は bootstrap が注入する (会話 id はツール定義の生成時に渡す)
    const host = pi.serveHosts.at(-1);
    assert.ok(host, "setServe が呼ばれる");
    assert.equal(host.configured, true);
    assert.match(await host.run(first, { action: "status" }), /served app: not reachable/);

    // モデルは会話 id を申告できない (パラメータは action と command だけ)
    const [definition] = createServeToolDefinitions({ enabled: true, sessionId: first, host });
    assert.ok(definition);
    assert.equal(definition.name, "serve");
    const parameters = definition.parameters as { properties?: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), ["action", "command"]);
    assert.deepEqual(parameters.required, ["action"]);

    // 未設定・会話 id 無しでは公開しない
    assert.deepEqual(createServeToolDefinitions({ enabled: false, sessionId: first, host }), []);
    assert.deepEqual(createServeToolDefinitions({ enabled: true, host }), []);
    assert.deepEqual(withServeTool(["read", "bash"], false), ["read", "bash"]);
    assert.deepEqual(withServeTool(["read"], true), ["read", "serve"]);
  } finally {
    await bff.close();
  }
});

test("serve はサンドボックスへ送るツールではない (リモート定義にも allowlist にも入らない)", () => {
  const sandbox = createServeSandboxStub();
  assert.ok(!(SANDBOX_TOOL_NAMES as readonly string[]).includes("serve"));
  assert.throws(
    () =>
      createRemoteToolDefinitions({
        cwd: "/workspace",
        rootCwd: "/workspace",
        sandboxCwd: "",
        client: sandbox.sandbox as never,
        masker: createSecretMasker([]),
        tools: ["serve"],
      }),
    UnknownRemoteToolError,
  );
});

test("serve ツールの実行は GUI と同じ経路を通り、起動コマンドを実績へ記録する", async () => {
  const { bff, sandbox, pi, first } = await setup();
  try {
    const host = pi.serveHosts.at(-1);
    assert.ok(host);
    const started = await host.run(first, { action: "start", command: "pnpm dev --port 8080" });
    assert.match(started, /served app: reachable/);
    assert.match(started, /started by this conversation/);
    assert.deepEqual(sandbox.state.launched, [
      { workdir: "", command: "pnpm dev --port 8080", log: ".u7agent/serve/app.log" },
    ]);
    assert.equal(bff.appDb.getServeCommand("")?.command, "pnpm dev --port 8080");

    // command 省略の start は実績を再利用する
    await host.run(first, { action: "stop" });
    await host.run(first, { action: "start" });
    assert.equal(sandbox.state.launched.at(-1)?.command, "pnpm dev --port 8080");
    // 空白だけの command も実績へ戻す (モデルの取り違えで空のコマンドを記録しない)
    await host.run(first, { action: "stop" });
    await host.run(first, { action: "start", command: "  " });
    assert.equal(sandbox.state.launched.at(-1)?.command, "pnpm dev --port 8080");
  } finally {
    await bff.close();
  }
});

test("createServeToolHost は status / stop の結果をそのまま説明文にする", async () => {
  const sandbox = createServeSandboxStub();
  const { ServeService } = await import("../src/serve");
  const service = new ServeService({
    appDb: {
      getServeCommand: () => undefined,
      saveServeCommand: () => {},
    },
    sessions: { workdirOfId: (id) => (id === "aaaa000001" ? "" : undefined), titleOfId: () => "t" },
    sandbox: sandbox.sandbox,
    probe: async () => false,
  });
  const host = createServeToolHost(service);
  assert.equal(host.configured, true);
  assert.match(await host.run("aaaa000001", { action: "status" }), /start command for this working directory: none/);
  assert.match(await host.run("aaaa000001", { action: "stop" }), /served app: not reachable/);
});
