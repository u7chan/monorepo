// serve (サービス) の HTTP 契約とツール配線。サンドボックスはスクリプトを解釈するスタブへ差し替える。
//   - 状態 / 起動 / 停止の応答が ServeStatusSchema を満たす
//   - 403 (他会話の所有者) / 409 (照合不一致) / 400 / 404 / 502 / 503 の分岐
//   - serve ツールは BFF ローカルの customTool として登録され、サンドボックスへは送られない
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBffApp } from "../src/app";
import { createSecretMasker } from "../src/redact";
import {
  RuntimeDebugServeStatusSchema,
  RuntimeDebugServeStopResultSchema,
  RuntimeServeStatusSchema,
  ServeStatusSchema,
} from "../src/schema";
import { UnknownRemoteToolError, createRemoteToolDefinitions } from "../src/sandbox/remote-tools";
import { SANDBOX_TOOL_NAMES } from "../src/sandbox/service";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { DEBUG_SERVE_PORT_FROM } from "../src/serve";
import {
  createServeToolDefinitions,
  createServeToolHost,
  SERVE_TOOL_GUIDELINES,
  withServeTool,
} from "../src/serve-tool";
import { createServeSandboxStub, publicListener, setPublicListener } from "./serve-stub";
import { asPiBff, createStubPi } from "./stub-pi";

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const workspace: SandboxWorkspaceClient = {
  previewFile: async () => ({ text: "" }),
  statFile: async (path: string) => ({ path }),
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
    serveProbe: async () => publicListener(sandbox.state) !== null,
  });
  const first = (await jsonBody(await bff.app.request("/api/sessions", jsonPost({})))) as { sessionId: string };
  const second = (await jsonBody(await bff.app.request("/api/sessions", jsonPost({})))) as { sessionId: string };
  bff.appDb.saveServeCommand({ cwd: "", command: "pnpm dev", updatedAt: 1 });
  return { bff, sandbox, pi, first: first.sessionId, second: second.sessionId };
}

/** スペース削除は会話ストアを必要とするため、実ストアを持つアプリを別に組む (setup は永続化なし) */
async function setupWithStore(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-serve-space-"));
  const sandbox = createServeSandboxStub();
  const pi = createStubPi();
  const bff = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: dir,
    pi: asPiBff(pi),
    workspace,
    serveSandbox: sandbox.sandbox,
    serveProbe: async () => publicListener(sandbox.state) !== null,
  });
  t.after(async () => {
    await bff.close();
    await rm(dir, { recursive: true, force: true });
  });
  const space = async (name: string) =>
    (await jsonBody(await bff.app.request("/api/spaces", jsonPost({ name })))).space as { id: string };
  const session = async (spaceId: string) =>
    (await jsonBody(await bff.app.request("/api/sessions", jsonPost({ spaceId })))) as {
      sessionId: string;
      cwd: string;
    };
  return { bff, sandbox, pi, space, session };
}

test("ランタイムは会話未選択でも全体の状態を取得し、所有者のサービスを停止できる", async () => {
  const { bff, sandbox, first } = await setup();
  try {
    const initial = await jsonBody(await bff.app.request("/api/serve/runtime/status"));
    assert.deepEqual(initial, { reachable: false, owner: null, generation: null, command: null });
    await bff.app.request("/api/serve/start", jsonPost({ sessionId: first }));
    const status = await jsonBody(await bff.app.request("/api/serve/runtime/status"));
    assert.equal(RuntimeServeStatusSchema.safeParse(status).success, true);
    assert.deepEqual(status.owner, { sessionId: first, title: "無題のセッション", spaceId: "default" });
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

test("実行状況からの起動は別スペースの会話も起動し、実績なし・世代不一致を区別する", async (t) => {
  const { bff, sandbox, space, session } = await setupWithStore(t);
  const target = await space("別スペース");
  const created = await session(target.id);
  bff.appDb.saveServeCommand({ cwd: created.cwd, command: "pnpm dev", updatedAt: 1 });
  const withoutCommand = await session("default");

  // 実績の無い会話は、既存のサービスを止めずに 400 にする
  const missing = await bff.app.request("/api/serve/runtime/start", jsonPost({ sessionId: withoutCommand.sessionId }));
  assert.equal(missing.status, 400);
  assert.match((await jsonBody(missing)).error, /実績/);
  assert.deepEqual(sandbox.state.killed, []);

  // 別スペースの会話でも起動でき、応答は全体の状態 (設定 → ランタイムと同じ形)
  const started = await bff.app.request("/api/serve/runtime/start", jsonPost({ sessionId: created.sessionId }));
  assert.equal(started.status, 200);
  const status = await jsonBody(started);
  assert.equal(RuntimeServeStatusSchema.safeParse(status).success, true);
  assert.deepEqual(status.owner, { sessionId: created.sessionId, title: "無題のセッション", spaceId: target.id });
  assert.deepEqual(status.command, { cwd: created.cwd, command: "pnpm dev" });
  assert.deepEqual(await jsonBody(await bff.app.request("/api/serve/runtime/status")), status);

  // 確認した世代と実行時の値が違えば 409 (自動で置き換えない)
  const conflict = await bff.app.request(
    "/api/serve/runtime/start",
    jsonPost({ sessionId: created.sessionId, generation: "stale" }),
  );
  assert.equal(conflict.status, 409);
  assert.equal(sandbox.state.killed.length, 0);

  // body の契約と未知の会話
  assert.equal((await bff.app.request("/api/serve/runtime/start", jsonPost({}))).status, 400);
  assert.equal((await bff.app.request("/api/serve/runtime/start", jsonPost({ sessionId: "unknown000" }))).status, 404);
});

test("スペース削除は公開中のサービスを 409 で止め、停止すると消せる", async (t) => {
  const { bff, sandbox, space, session } = await setupWithStore(t);
  const target = await space("消す");
  const targetSession = await session(target.id);
  bff.appDb.saveServeCommand({ cwd: targetSession.cwd, command: "pnpm dev", updatedAt: 1 });
  const started = await bff.app.request(
    `/api/serve/start?spaceId=${target.id}`,
    jsonPost({ sessionId: targetSession.sessionId }),
  );
  assert.equal(started.status, 200);

  // 起動元がこのスペースの会話なら 409 (共有枠の停止は削除に混ぜない)
  const blocked = await bff.app.request(`/api/spaces/${target.id}`, { method: "DELETE" });
  assert.equal(blocked.status, 409);
  assert.match((await jsonBody(blocked)).error, /停止/);
  assert.equal((await bff.app.request(`/api/sessions/${targetSession.sessionId}?spaceId=${target.id}`)).status, 200);
  assert.equal(
    (await jsonBody(await bff.app.request("/api/spaces"))).spaces.some((item: { id: string }) => item.id === target.id),
    true,
  );

  // 記録と待受ソケットが一致しない (起動元不明) でも、到達可なら 409 にする
  sandbox.state.stateFiles.clear();
  assert.equal((await bff.app.request(`/api/spaces/${target.id}`, { method: "DELETE" })).status, 409);

  // 停止すると削除できる
  const generation = (await jsonBody(await bff.app.request("/api/serve/runtime/status"))).generation as string;
  const stopped = await bff.app.request("/api/serve/runtime/stop", jsonPost({ generation }));
  assert.equal(stopped.status, 200);
  assert.equal((await bff.app.request(`/api/spaces/${target.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await bff.app.request(`/api/sessions/${targetSession.sessionId}?spaceId=${target.id}`)).status, 404);
});

test("起動元が他会話スペースのサービスはスペース削除を妨げない", async (t) => {
  const { bff, space, session } = await setupWithStore(t);
  const keep = await space("残す");
  const keepSession = await session(keep.id);
  bff.appDb.saveServeCommand({ cwd: keepSession.cwd, command: "pnpm dev", updatedAt: 1 });
  const started = await bff.app.request(
    `/api/serve/start?spaceId=${keep.id}`,
    jsonPost({ sessionId: keepSession.sessionId }),
  );
  assert.equal(started.status, 200);

  const target = await space("消す");
  const targetSession = await session(target.id);
  assert.equal((await bff.app.request(`/api/spaces/${target.id}`, { method: "DELETE" })).status, 200);
  // 対象スペースの会話は消え、起動元のサービスとそのスペースは無傷
  assert.equal((await bff.app.request(`/api/sessions/${targetSession.sessionId}?spaceId=${target.id}`)).status, 404);
  assert.equal((await bff.app.request(`/api/sessions/${keepSession.sessionId}?spaceId=${keep.id}`)).status, 200);
  const runtime = await jsonBody(await bff.app.request("/api/serve/runtime/status"));
  assert.equal(runtime.reachable, true);
  assert.deepEqual(runtime.owner, { sessionId: keepSession.sessionId, title: "無題のセッション", spaceId: keep.id });
});

test("スペース削除の稼働判定は状態のキャッシュを読まない", async (t) => {
  const { bff, sandbox, space, session } = await setupWithStore(t);
  const target = await space("デモ");
  const created = await session(target.id);
  // 停止中の状態をキャッシュへ載せる
  assert.equal((await jsonBody(await bff.app.request("/api/serve/runtime/status"))).reachable, false);
  // 記録を介さない起動 (直前の bash 起動) を再現する
  setPublicListener(sandbox.state, { pid: 9999, startedAt: 1, inodes: [777], ancestors: [9999] });
  // ポーリングはキャッシュのまま停止を示す
  assert.equal((await jsonBody(await bff.app.request("/api/serve/runtime/status"))).reachable, false);
  // 削除は取り直すので、到達可 + 起動元不明 の 409 になる (何も消えない)
  const blocked = await bff.app.request(`/api/spaces/${target.id}`, { method: "DELETE" });
  assert.equal(blocked.status, 409);
  assert.equal((await bff.app.request(`/api/sessions/${created.sessionId}?spaceId=${target.id}`)).status, 200);
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
    // 実績があってもサンドボックス未設定では起動しない (状態を取得できないのを停止中へ丸めない)
    unconfigured.appDb.saveServeCommand({ cwd: "", command: "pnpm dev", updatedAt: 1 });
    assert.equal(
      (await unconfigured.app.request("/api/serve/runtime/start", jsonPost({ sessionId: created.sessionId }))).status,
      503,
    );
    assert.match((await jsonBody(response)).error, /PI_SANDBOX_URL/);
    assert.equal(pi.serveHosts.at(-1)?.configured, false, "未設定ではツールを公開しない");
    // スペース削除もサンドボックス未設定は 503 (稼働を見られないまま消さない)
    const space = (await jsonBody(await unconfigured.app.request("/api/spaces", jsonPost({ name: "デモ" })))) as {
      space: { id: string };
    };
    const removal = await unconfigured.app.request(`/api/spaces/${space.space.id}`, { method: "DELETE" });
    assert.equal(removal.status, 503);
    assert.equal((await jsonBody(removal)).state, undefined);
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
    // スペース削除も同じプローブを通る (稼働を見落とさずに消さない)
    const space = (await jsonBody(await failing.app.request("/api/spaces", jsonPost({ name: "デモ" })))) as {
      space: { id: string };
    };
    assert.equal((await failing.app.request(`/api/spaces/${space.space.id}`, { method: "DELETE" })).status, 502);
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

    // 外したビルトイン skill は説明からも落ちる (system prompt の serveSkillClause と同じ判定)
    assert.match(definition.description, /Follow the bundled `serve` skill/);
    // 種別ごとの注入先は定義側の 1 文で伝え、契約の正は同梱の serve スキルに置く
    assert.deepEqual(definition.promptGuidelines, [...SERVE_TOOL_GUIDELINES]);
    const guidelines = (definition.promptGuidelines ?? []).join("\n");
    assert.match(guidelines, /also reach bash/);
    assert.match(guidelines, /secrets reach only the process started by start or debug_start/);
    assert.match(guidelines, /\[REDACTED\]/);
    const [withoutBuiltins] = createServeToolDefinitions({
      enabled: true,
      sessionId: first,
      host,
      builtinSkillNames: [],
    });
    assert.doesNotMatch(withoutBuiltins.description, /bundled/);
    assert.match(withoutBuiltins.description, /0\.0\.0\.0:8080/, "起動の必須条件は skill に依存しない");
    const [otherBuiltin] = createServeToolDefinitions({
      enabled: true,
      sessionId: first,
      host,
      builtinSkillNames: ["skill-creator"],
    });
    assert.doesNotMatch(otherBuiltin.description, /bundled `serve` skill/);
    const [manualOnly] = createServeToolDefinitions({
      enabled: true,
      sessionId: first,
      host,
      allowNaturalInvocation: false,
    });
    assert.doesNotMatch(manualOnly.description, /bundled `serve` skill/);

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
      { workdir: "", command: "pnpm dev --port 8080", log: ".u7agent/serve/app.log", port: null },
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
    sessions: {
      workdirOfId: (id) => (id === "aaaa000001" ? "" : undefined),
      titleOfId: () => "t",
      spaceOfId: () => "default",
    },
    sandbox: sandbox.sandbox,
    probe: async () => false,
  });
  const host = createServeToolHost(service);
  assert.equal(host.configured, true);
  assert.match(await host.run("aaaa000001", { action: "status" }), /start command for this working directory: none/);
  assert.match(await host.run("aaaa000001", { action: "stop" }), /served app: not reachable/);
});

// --- デバッグ用 serve (公開枠とは別の 18000–18099。削除時の回収も含む) ---

const DEBUG_FROM = DEBUG_SERVE_PORT_FROM;
const DEBUG_COMMAND = "pnpm dev --host 127.0.0.1 --port $U7AGENT_DEBUG_PORT";

/** ツール応答からデバッグ用ポートを読む (モデルと同じく、常に応答の値を使う) */
function debugPortOf(text: string): number {
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(text)?.[1]);
  assert.ok(Number.isInteger(port), `ポートが読めない: ${text}`);
  return port;
}

test("会話削除はその会話のデバッグ用 serve を停止し、実績を汚さない", async () => {
  const { bff, sandbox, pi, first, second } = await setup();
  try {
    const host = pi.serveHosts.at(-1);
    assert.ok(host);
    const started = await host.run(first, { action: "debug_start", command: DEBUG_COMMAND });
    assert.equal(debugPortOf(started), DEBUG_FROM);
    assert.match(started, /http:\/\/127\.0\.0\.1:18000\//);
    assert.match(started, /not shown in the user's service UI/, "ユーザーの UI に出ないことを応答に含める");
    // デバッグ起動は GUI の起動実績 (serve_commands) を書き換えない
    assert.equal(bff.appDb.getServeCommand("")?.command, "pnpm dev");
    const other = await host.run(second, { action: "debug_start", command: DEBUG_COMMAND });
    assert.equal(debugPortOf(other), DEBUG_FROM + 1);

    // 状態は自会話のポートと待受を返す
    const seen = await host.run(first, { action: "debug_status" });
    assert.match(seen, /listening on http:\/\/127\.0\.0\.1:18000\//);

    assert.equal((await bff.app.request(`/api/sessions/${first}`, { method: "DELETE" })).status, 200);
    assert.equal(sandbox.state.listeners.has(DEBUG_FROM), false, "削除した会話のデバッグを停止する");
    assert.equal(sandbox.state.listeners.has(DEBUG_FROM + 1), true, "他会話のデバッグは残す");
    assert.equal(bff.appDb.getServeCommand("")?.command, "pnpm dev");

    // debug_stop はポートの解放を確認して返し、二重停止も成功として返す
    assert.match(await host.run(second, { action: "debug_stop" }), /stopped \(port released\)/);
    assert.match(await host.run(second, { action: "debug_stop" }), /none for this conversation/);
    assert.equal(sandbox.state.listeners.size, 0);
  } finally {
    await bff.close();
  }
});

test("デバッグの停止に失敗しても会話削除は成功し、理由は warn に残る", async () => {
  const { bff, sandbox, pi, first } = await setup();
  const warnings: unknown[][] = [];
  const original = console.warn;
  try {
    const host = pi.serveHosts.at(-1);
    assert.ok(host);
    await host.run(first, { action: "debug_start", command: DEBUG_COMMAND });
    // 停止対象の照合 (待受の走査) が失敗する状態を作る
    sandbox.state.scanFailures = 1;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    assert.equal((await bff.app.request(`/api/sessions/${first}`, { method: "DELETE" })).status, 200);
    assert.equal(sandbox.state.listeners.has(DEBUG_FROM), true, "停止できなかった待受は残る (回収はユーザーの操作)");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /デバッグ用 serve を停止できませんでした/);
  } finally {
    console.warn = original;
    await bff.close();
  }
});

test("スペース削除は対象スペースの会話のデバッグ用 serve だけを停止する", async (t) => {
  const { bff, sandbox, pi, space, session } = await setupWithStore(t);
  const host = pi.serveHosts.at(-1);
  assert.ok(host);
  const target = await space("消す");
  const targetSession = await session(target.id);
  const keep = await space("残す");
  const keepSession = await session(keep.id);
  const targetPort = debugPortOf(
    await host.run(targetSession.sessionId, { action: "debug_start", command: DEBUG_COMMAND }),
  );
  const keepPort = debugPortOf(
    await host.run(keepSession.sessionId, { action: "debug_start", command: DEBUG_COMMAND }),
  );
  assert.notEqual(targetPort, keepPort);
  assert.equal((await bff.app.request(`/api/spaces/${target.id}`, { method: "DELETE" })).status, 200);
  assert.equal(sandbox.state.listeners.has(targetPort), false);
  assert.equal(sandbox.state.listeners.has(keepPort), true);
});

test("サンドボックス未設定でもデバッグの回収は会話削除を止めない", async () => {
  const unconfigured = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: asPiBff(createStubPi()),
    workspace,
    serveSandbox: null,
    serveProbe: async () => false,
  });
  try {
    const created = (await jsonBody(await unconfigured.app.request("/api/sessions", jsonPost({})))) as {
      sessionId: string;
    };
    assert.equal(
      (await unconfigured.app.request(`/api/sessions/${created.sessionId}`, { method: "DELETE" })).status,
      200,
    );
    // デバッグの一覧 / 停止はサンドボックス未設定を 503 で返す (公開 API の停止中とは区別する)
    assert.equal((await unconfigured.app.request("/api/serve/debug/status")).status, 503);
    assert.equal((await unconfigured.app.request("/api/serve/debug/stop", jsonPost({ port: DEBUG_FROM }))).status, 503);
  } finally {
    await unconfigured.close();
  }
});

test("デバッグ一覧は起動元と起動時の値を返し、追跡外はポートだけにする", async () => {
  const { bff, sandbox, pi, first } = await setup();
  try {
    const host = pi.serveHosts.at(-1);
    assert.ok(host);
    const started = debugPortOf(await host.run(first, { action: "debug_start", command: DEBUG_COMMAND }));
    const orphanPort = DEBUG_FROM + 5;
    sandbox.state.listeners.set(orphanPort, {
      pid: 9001,
      startedAt: 1_700_000_000_000,
      inodes: [9001],
      ancestors: [9001],
    });
    const status = await jsonBody(await bff.app.request("/api/serve/debug/status"));
    assert.equal(RuntimeDebugServeStatusSchema.safeParse(status).success, true);
    assert.deepEqual(status, {
      servers: [
        {
          port: started,
          owner: { sessionId: first, title: "無題のセッション", spaceId: "default" },
          command: DEBUG_COMMAND,
          startedAt: sandbox.state.launchStartedAt,
        },
        { port: orphanPort, owner: null, command: null, startedAt: null },
      ],
    });
    // 公開枠の応答にはデバッグを混ぜない
    assert.deepEqual(await jsonBody(await bff.app.request("/api/serve/runtime/status")), {
      reachable: false,
      owner: null,
      generation: null,
      command: null,
    });
  } finally {
    await bff.close();
  }
});

test("デバッグの強制停止は所有者を問わず、一覧から待受を消す", async () => {
  const { bff, sandbox, pi, first, second } = await setup();
  try {
    const host = pi.serveHosts.at(-1);
    assert.ok(host);
    const tracked = debugPortOf(await host.run(first, { action: "debug_start", command: DEBUG_COMMAND }));
    const orphanPort = DEBUG_FROM + 5;
    sandbox.state.listeners.set(orphanPort, {
      pid: 9001,
      startedAt: 1_700_000_000_000,
      inodes: [9001],
      ancestors: [9001],
    });

    // 起動元の会話 (second) とは別の会話で開いても、所有者を問わず停止できる
    for (const body of [{}, { port: 80 }, { port: DEBUG_FROM - 1 }, { port: "18000" }, { port: tracked, extra: 1 }]) {
      assert.equal((await bff.app.request("/api/serve/debug/stop", jsonPost(body))).status, 400);
    }
    const csrf = await bff.app.request("http://app.test/api/serve/debug/stop", {
      ...jsonPost({ port: tracked }),
      headers: { Origin: "http://evil.test", "Content-Type": "application/json" },
    });
    assert.equal(csrf.status, 403);
    assert.deepEqual(sandbox.state.killed, []);

    // 待受の無いポートは停止済みとして返す (二重停止も成功)
    assert.deepEqual(
      await jsonBody(await bff.app.request("/api/serve/debug/stop", jsonPost({ port: DEBUG_FROM + 9 }))),
      {
        port: DEBUG_FROM + 9,
        released: false,
        alreadyStopped: true,
      },
    );
    for (const port of [orphanPort, tracked]) {
      const stopped = await jsonBody(await bff.app.request("/api/serve/debug/stop", jsonPost({ port })));
      assert.equal(RuntimeDebugServeStopResultSchema.safeParse(stopped).success, true);
      assert.deepEqual(stopped, {
        port,
        released: true,
        alreadyStopped: false,
      });
    }
    assert.equal(sandbox.state.listeners.size, 0);
    assert.deepEqual(await jsonBody(await bff.app.request("/api/serve/debug/status")), { servers: [] });
    // 会話からの停止 (lease の持ち主) はすでに待受が無い
    assert.match(await host.run(second, { action: "debug_status" }), /none for this conversation/);
  } finally {
    await bff.close();
  }
});

test("デバッグ一覧は待受が消えた lease を掃除し、追跡外として見せる", async () => {
  const { bff, sandbox, pi, first } = await setup();
  try {
    const host = pi.serveHosts.at(-1);
    assert.ok(host);
    const started = debugPortOf(await host.run(first, { action: "debug_start", command: DEBUG_COMMAND }));
    sandbox.state.listeners.delete(started);
    assert.deepEqual(await jsonBody(await bff.app.request("/api/serve/debug/status")), { servers: [] });
    // 掃除されたので、次の起動は同じポートを再利用できる
    const restarted = await host.run(first, { action: "debug_start", command: DEBUG_COMMAND });
    assert.equal(debugPortOf(restarted), started);
    assert.deepEqual(sandbox.state.killed, [], "掃除で残骸を stop しようとしない");
  } finally {
    await bff.close();
  }
});
