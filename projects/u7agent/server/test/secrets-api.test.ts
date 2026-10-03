// 作業環境 → 環境変数 の HTTP 契約。シークレットの値がどの応答にも載らないこと、
// 別の cwd の会話からは参照できないこと、master key 未設定では保存も利用も拒否することを見る。
import assert from "node:assert/strict";
import test from "node:test";
import { createBffApp } from "../src/app";
import { SECRET_MASTER_KEY_ENV, SECRET_KEY_BYTES } from "../src/secret-crypto";
import type { SandboxWorkspaceClient } from "../src/sandbox/client";
import { asPiBff, createStubPi } from "./stub-pi";

const KEY = Buffer.alloc(SECRET_KEY_BYTES, 9).toString("base64");

const jsonPost = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
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
  rawFile: async () => ({ contentType: "image/png", body: null }),
  downloadEntry: async () => ({
    contentType: "application/octet-stream",
    contentDisposition: "attachment",
    body: null,
  }),
  checkDownload: async () => ({ kind: "file", name: "a.txt", bytes: 0, entries: 0, skipped: [] }),
};

/** 2 つのプロジェクト (= 別の cwd) と、その配下の会話を 1 つずつ作る */
async function setup(options: { masterKey?: boolean } = {}) {
  const previous = process.env[SECRET_MASTER_KEY_ENV];
  if (options.masterKey === false) delete process.env[SECRET_MASTER_KEY_ENV];
  else process.env[SECRET_MASTER_KEY_ENV] = `1:${KEY}`;
  const pi = createStubPi();
  const bff = await createBffApp({
    cwd: "/workspace",
    sessionStoreDir: null,
    pi: asPiBff(pi),
    workspace,
  });
  const alpha = await jsonBody(
    await bff.app.request("/api/projects", jsonPost({ cwd: "projects/alpha", name: "alpha" })),
  );
  const beta = await jsonBody(await bff.app.request("/api/projects", jsonPost({ cwd: "projects/beta", name: "beta" })));
  const sessionA = await jsonBody(await bff.app.request("/api/sessions", jsonPost({ projectId: alpha.project.id })));
  const sessionB = await jsonBody(await bff.app.request("/api/sessions", jsonPost({ projectId: beta.project.id })));
  return {
    bff,
    pi,
    alphaId: alpha.project.id as string,
    a: sessionA.sessionId as string,
    b: sessionB.sessionId as string,
    restore: () => {
      if (previous === undefined) delete process.env[SECRET_MASTER_KEY_ENV];
      else process.env[SECRET_MASTER_KEY_ENV] = previous;
    },
  };
}

test("登録 → 一覧 → 詳細 → 上書き → 削除の往復で、シークレットの値は応答に一切載らない", async () => {
  const { bff, a, restore } = await setup();
  try {
    const created = await jsonBody(
      await bff.app.request(
        "/api/secrets",
        jsonPost({ sessionId: a, kind: "secret", name: " api_key ", value: "  dummy-secret-1234  " }),
      ),
    );
    assert.equal(created.item.name, "API_KEY");
    assert.equal(created.item.kind, "secret");
    assert.equal(created.trimmed, true, "前後の空白を除去した注記が返らない");
    assert.equal(typeof created.generation, "string");

    const list = await jsonBody(await bff.app.request(`/api/secrets?sessionId=${a}`));
    assert.deepEqual(
      list.items.map((item: { name: string; kind: string }) => [item.name, item.kind]),
      [["API_KEY", "secret"]],
    );
    assert.equal(JSON.stringify(list).includes("dummy-secret-1234"), false, "一覧に値が載っている");

    const detail = await jsonBody(await bff.app.request(`/api/secrets/${created.item.secretId}?sessionId=${a}`));
    assert.equal("value" in detail, false, "シークレットの詳細に値がある");

    const updated = await jsonBody(
      await bff.app.request(
        `/api/secrets/${created.item.secretId}`,
        jsonPut({ sessionId: a, value: "dummy-secret-5678" }),
      ),
    );
    assert.equal(updated.trimmed, false);
    assert.notEqual(updated.generation, created.generation, "上書きで世代が変わらない");

    const removed = await jsonBody(
      await bff.app.request(`/api/secrets/${created.item.secretId}?sessionId=${a}`, { method: "DELETE" }),
    );
    assert.equal(removed.removed, true);
    const after = await jsonBody(await bff.app.request(`/api/secrets?sessionId=${a}`));
    assert.deepEqual(after.items, []);
  } finally {
    await bff.close();
    restore();
  }
});

test("変数は変更フォーム用の詳細だけが平文を返し、エージェント向けの解決にも入る", async () => {
  const { bff, pi, a, restore } = await setup();
  try {
    const created = await jsonBody(
      await bff.app.request(
        "/api/secrets",
        jsonPost({ sessionId: a, kind: "variable", name: "node_env", value: "production" }),
      ),
    );
    assert.equal(created.item.name, "NODE_ENV");
    const detail = await jsonBody(await bff.app.request(`/api/secrets/${created.item.secretId}?sessionId=${a}`));
    assert.equal(detail.value, "production");
    // 一覧は名前・種別・更新時刻だけ (変数の値も載せない)
    const list = await jsonBody(await bff.app.request(`/api/secrets?sessionId=${a}`));
    assert.equal(JSON.stringify(list).includes("production"), false);
    // bootstrap が注入した解決源はシークレットを含まない形で変数を返す
    assert.deepEqual(pi.sessionEnvs.at(-1)?.variablesFor("projects/alpha"), { NODE_ENV: "production" });
  } finally {
    await bff.close();
    restore();
  }
});

test("シークレットの復号値はマスカーへ登録され、短い値は登録されない", async () => {
  const { bff, pi, a, restore } = await setup();
  try {
    await bff.app.request(
      "/api/secrets",
      jsonPost({ sessionId: a, kind: "secret", name: "LONG_VALUE", value: "dummy-long-1234" }),
    );
    await bff.app.request("/api/secrets", jsonPost({ sessionId: a, kind: "secret", name: "SHORT", value: "abc123" }));
    assert.ok(pi.retainedSecrets.includes("dummy-long-1234"), "保存時の登録が無い");
    assert.equal(pi.retainedSecrets.includes("abc123"), false, "8 文字未満が登録されている");
    // 会話表示のマスクに効く (8 文字以上は [REDACTED]、短い値は素通し)
    assert.match(pi.secretMasker.mask("value is dummy-long-1234 here"), /\[REDACTED\]/);
    assert.equal(pi.secretMasker.mask("value is abc123 here"), "value is abc123 here");
  } finally {
    await bff.close();
    restore();
  }
});

test("プロジェクトの登録解除では秘密を消さず、同じ cwd を再登録すると同じ設定が戻る", async () => {
  const { bff, alphaId, a, restore } = await setup();
  try {
    await bff.app.request(
      "/api/secrets",
      jsonPost({ sessionId: a, kind: "secret", name: "API_KEY", value: "dummy-value-1234" }),
    );
    const removed = await bff.app.request(`/api/projects/${alphaId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    // 会話の cwd は登録解除後も登録ディレクトリのままで、秘密はそのまま残る
    const after = await jsonBody(await bff.app.request(`/api/secrets?sessionId=${a}`));
    assert.deepEqual(
      after.items.map((item: { name: string }) => item.name),
      ["API_KEY"],
    );
    // 同じ cwd を再登録すると projectId でも同じ設定が引ける
    const again = await jsonBody(
      await bff.app.request("/api/projects", jsonPost({ cwd: "projects/alpha", name: "alpha2" })),
    );
    const byProject = await jsonBody(await bff.app.request(`/api/secrets?projectId=${again.project.id}`));
    assert.deepEqual(
      byProject.items.map((item: { name: string }) => item.name),
      ["API_KEY"],
    );
  } finally {
    await bff.close();
    restore();
  }
});

test("別の cwd の会話からは、secret_id を指定しても参照・変更・削除できない", async () => {
  const { bff, a, b, restore } = await setup();
  try {
    const created = await jsonBody(
      await bff.app.request(
        "/api/secrets",
        jsonPost({ sessionId: a, kind: "secret", name: "API_KEY", value: "dummy-value-1234" }),
      ),
    );
    const other = await bff.app.request(`/api/secrets?sessionId=${b}`);
    assert.deepEqual((await jsonBody(other)).items, [], "他会話に一覧が見えている");
    for (const [label, response] of [
      ["詳細", await bff.app.request(`/api/secrets/${created.item.secretId}?sessionId=${b}`)],
      [
        "上書き",
        await bff.app.request(
          `/api/secrets/${created.item.secretId}`,
          jsonPut({ sessionId: b, value: "dummy-value-9999" }),
        ),
      ],
      ["削除", await bff.app.request(`/api/secrets/${created.item.secretId}?sessionId=${b}`, { method: "DELETE" })],
    ] as const) {
      assert.equal((response as Response).status, 404, `${label}が拒否されていない`);
    }
    // 持ち主の会話からは見えたまま
    const mine = await jsonBody(await bff.app.request(`/api/secrets?sessionId=${a}`));
    assert.deepEqual(
      mine.items.map((item: { name: string }) => item.name),
      ["API_KEY"],
    );
  } finally {
    await bff.close();
    restore();
  }
});

test("プロジェクト起点の新規会話は projectId で同じ作業フォルダの設定を読める", async () => {
  const { bff, alphaId, a, restore } = await setup();
  try {
    await bff.app.request(
      "/api/secrets",
      jsonPost({ sessionId: a, kind: "variable", name: "NODE_ENV", value: "test" }),
    );
    const byProject = await jsonBody(await bff.app.request(`/api/secrets?projectId=${alphaId}`));
    assert.deepEqual(
      byProject.items.map((item: { name: string }) => item.name),
      ["NODE_ENV"],
    );
    assert.equal(byProject.projectScoped, true);
  } finally {
    await bff.close();
    restore();
  }
});

test("名前・値・要求元の検証は 400 / 404 / 409 で返す", async () => {
  const { bff, a, restore } = await setup();
  try {
    const create = async (payload: Record<string, unknown>): Promise<Response> =>
      await bff.app.request("/api/secrets", jsonPost({ sessionId: a, kind: "variable", value: "v", ...payload }));
    assert.equal((await create({ name: "PATH" })).status, 400, "予約名");
    assert.equal((await create({ name: "1BAD" })).status, 400, "先頭が数字");
    assert.equal((await create({ name: "OK", value: "  " })).status, 400, "空値");
    assert.equal(
      (await create({ kind: "secret", name: "VITE_KEY", value: "dummy-value" })).status,
      400,
      "公開プレフィックス",
    );
    assert.equal((await create({ name: "DUP" })).status, 200);
    assert.equal((await create({ name: "dup" })).status, 409, "同名の重複");
    assert.equal(
      (await bff.app.request("/api/secrets", jsonPost({ kind: "variable", name: "X", value: "v" }))).status,
      400,
      "要求元の指定なし",
    );
    assert.equal((await bff.app.request("/api/secrets?sessionId=missing")).status, 404);
    // 両方の指定は「どちらか一方だけ」の 400 (曖昧なまま解決しない)
    assert.equal((await bff.app.request("/api/secrets?sessionId=unknown&projectId=x")).status, 400);
  } finally {
    await bff.close();
    restore();
  }
});

test("master key が未設定なら、シークレットは 503 not_stored で拒否し、変数は登録できる", async () => {
  const { bff, a, restore } = await setup({ masterKey: false });
  try {
    const secret = await bff.app.request(
      "/api/secrets",
      jsonPost({ sessionId: a, kind: "secret", name: "API_KEY", value: "dummy-value-1234" }),
    );
    assert.equal(secret.status, 503);
    assert.equal((await jsonBody(secret)).state, "not_stored");
    // 変数は平文なので master key に依存しない
    const variable = await bff.app.request(
      "/api/secrets",
      jsonPost({ sessionId: a, kind: "variable", name: "NODE_ENV", value: "production" }),
    );
    assert.equal(variable.status, 200);
  } finally {
    await bff.close();
    restore();
  }
});
