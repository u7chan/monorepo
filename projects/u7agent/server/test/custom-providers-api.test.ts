// カスタムプロバイダーの HTTP 契約 (POST / PUT / DELETE / GET)。実 API は呼ばず stub pi で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import {
  CUSTOM_PROVIDER_APPLY_FAILED_MESSAGE,
  CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE,
  CUSTOM_PROVIDER_KEY_TARGET_MESSAGE,
  CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE,
  CUSTOM_PROVIDER_NOT_FOUND_MESSAGE,
  CUSTOM_PROVIDER_RESYNC_TARGET_MESSAGE,
  CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE,
  CUSTOM_PROVIDER_STORED_ROWS_MESSAGE,
} from "../src/custom-providers";
import { asPiBff, createStubPi, type StubPiOptions } from "./stub-pi";

const KEY = "sk-custom-dummy-key-0123456789";
const NEW_KEY = "sk-custom-dummy-key-new-0123456789";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

function jsonRequest(method: string, payload?: unknown): RequestInit {
  return {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  };
}

function stubOptions(options: StubPiOptions = {}): StubPiOptions {
  return {
    providers: [
      { provider: "anthropic", name: "Anthropic", configured: true },
      { provider: "local", canSetApiKey: false },
    ],
    ...options,
  };
}

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-custom-providers-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const bodyOf = (patch: Record<string, unknown> = {}) => ({
  id: "local-llm",
  baseUrl: "http://192.0.2.10:11434/v1",
  apiKey: KEY,
  model: { id: "qwen2.5-coder:7b", contextWindow: 32768 },
  ...patch,
});

const updateBodyOf = (patch: Record<string, unknown> = {}) => ({
  baseUrl: "http://192.0.2.11:11434/v1",
  model: { id: "llama3:8b", contextWindow: 8192, maxTokens: 4096 },
  ...patch,
});

function countRows(dir: string, table: "provider_credentials" | "provider_memos"): number {
  const db = new DatabaseSync(join(dir, APP_DB_FILENAME));
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("POST は登録して GET と同じ形 + applied を返し、キーを応答に載せず DB に行を作らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const response = await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      assert.equal(response.status, 200);
      const body = await jsonBody(response);
      assert.equal(body.state, "applied");
      assert.equal(body.runtimeAvailable, true);
      assert.ok(!JSON.stringify(body).includes(KEY), "POST の応答にキーを載せない");
      assert.deepEqual(body.customProviders, [
        {
          id: "local-llm",
          name: "local-llm",
          baseUrl: "http://192.0.2.10:11434/v1",
          api: "openai-completions",
          model: { id: "qwen2.5-coder:7b", contextWindow: 32768, maxTokens: 16384 },
          hasKey: true,
        },
      ]);
      const provider = body.providers.find((entry: any) => entry.provider === "local-llm");
      assert.equal(provider.custom, true, "providers[] にも custom: true で載る (モデル選択の候補が使う)");
      assert.deepEqual(provider.auth, { configured: true, source: "runtime", environmentVariables: [] });
      assert.equal(provider.credentialKind, "api_key");
      assert.equal(provider.hiddenStoredOAuth, false);
      assert.equal(provider.managed, false, "provider_credentials は持たない");
      assert.equal(provider.keyUpdatedAt, null);

      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => call.operation),
        ["registerProvider", "setRuntimeApiKey"],
        "登録 → キー適用の順",
      );
      assert.deepEqual(pi.retainedSecrets, [KEY], "キーは SDK より前にマスク対象へ入れる");

      const get = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(get.customProviders.length, 1);
      assert.ok(!JSON.stringify(get).includes(KEY), "GET にもキーを載せない");

      assert.equal(countRows(dir, "provider_credentials"), 0, "provider_credentials に行を作らない");
      assert.equal(countRows(dir, "provider_memos"), 0, "provider_memos に行を作らない");
    } finally {
      await bff.close();
    }
  });
});

test("POST は複数登録でき、通常一覧には混ぜない (custom: true で区別できる)", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      await bff.app.request(
        "/api/settings/custom-providers",
        jsonRequest(
          "POST",
          bodyOf({
            id: "lab",
            baseUrl: "http://198.51.100.20:8000/v1",
            model: { id: "mistral:7b", contextWindow: 16384 },
          }),
        ),
      );
      const body = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.deepEqual(
        body.customProviders.map((entry: any) => entry.id),
        ["local-llm", "lab"],
      );
      const custom = body.providers.filter((entry: any) => entry.custom === true);
      assert.deepEqual(
        custom.map((entry: any) => entry.provider),
        ["local-llm", "lab"],
      );
    } finally {
      await bff.close();
    }
  });
});

test("POST の検証は 400 で、SDK を触らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const cases: [Record<string, unknown>, string | null][] = [
        [bodyOf({ id: "BadId" }), "英小文字"],
        [bodyOf({ baseUrl: "ftp://192.0.2.10/v1" }), "http / https"],
        [bodyOf({ apiKey: "short" }), "8〜2048"],
        [bodyOf({ model: { id: "m", contextWindow: 0 } }), "contextWindow"],
        [bodyOf({ id: "anthropic" }), CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE],
      ];
      for (const [body, expected] of cases) {
        const response = await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", body));
        assert.equal(response.status, 400, JSON.stringify(body));
        const payload = await jsonBody(response);
        if (expected) assert.ok(String(payload.error).includes(expected), `${payload.error} に ${expected}`);
      }

      // 形の違う本文 (キー欠落) は route の zod が 400 にする
      const missing = await bff.app.request(
        "/api/settings/custom-providers",
        jsonRequest("POST", { id: "x", baseUrl: "http://192.0.2.10/v1", model: { id: "m", contextWindow: 1 } }),
      );
      assert.equal(missing.status, 400);

      assert.deepEqual(pi.modelRuntimeCalls, [], "検証で止めたら SDK を触らない");
      assert.deepEqual(pi.retainedSecrets, []);
      const get = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.deepEqual(get.customProviders, []);
    } finally {
      await bff.close();
    }
  });
});

test("PUT は id を変えずに再登録し、キーの空欄は既存を維持する", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      pi.modelRuntimeCalls.length = 0;
      pi.retainedSecrets.length = 0;

      const response = await bff.app.request(
        "/api/settings/custom-providers/local-llm",
        jsonRequest("PUT", updateBodyOf({ name: "自宅のLLM", apiKey: "" })),
      );
      assert.equal(response.status, 200);
      const body = await jsonBody(response);
      assert.equal(body.state, "applied");
      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => call.operation),
        ["registerProvider"],
        "キーが空欄なら適用し直さない",
      );
      assert.deepEqual(pi.retainedSecrets, []);
      assert.deepEqual(body.customProviders, [
        {
          id: "local-llm",
          name: "自宅のLLM",
          baseUrl: "http://192.0.2.11:11434/v1",
          api: "openai-completions",
          model: { id: "llama3:8b", contextWindow: 8192, maxTokens: 4096 },
          hasKey: true,
        },
      ]);
      assert.ok(!JSON.stringify(body).includes(KEY));

      // 新しいキーは適用する
      await bff.app.request(
        "/api/settings/custom-providers/local-llm",
        jsonRequest("PUT", updateBodyOf({ apiKey: NEW_KEY })),
      );
      assert.equal(pi.modelRuntimeCalls.at(-1)?.apiKey, NEW_KEY);

      const unknown = await bff.app.request(
        "/api/settings/custom-providers/missing",
        jsonRequest("PUT", updateBodyOf()),
      );
      assert.equal(unknown.status, 400);
      assert.equal((await jsonBody(unknown)).error, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
    } finally {
      await bff.close();
    }
  });
});

test("DELETE はキーを外してから登録を外し、応答は GET と同じ形 + applied", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      pi.modelRuntimeCalls.length = 0;

      const response = await bff.app.request("/api/settings/custom-providers/local-llm", jsonRequest("DELETE"));
      assert.equal(response.status, 200);
      const body = await jsonBody(response);
      assert.equal(body.state, "applied");
      assert.deepEqual(body.customProviders, []);
      assert.equal(
        body.providers.find((entry: any) => entry.provider === "local-llm"),
        undefined,
        "runtime の一覧からも消える",
      );
      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => call.operation),
        ["removeRuntimeApiKey", "unregisterProvider"],
        "overlay を先に消す (逆だと再登録で古いキーが復活する)",
      );

      const again = await bff.app.request("/api/settings/custom-providers/local-llm", jsonRequest("DELETE"));
      assert.equal(again.status, 400);
      assert.equal((await jsonBody(again)).error, CUSTOM_PROVIDER_NOT_FOUND_MESSAGE);
    } finally {
      await bff.close();
    }
  });
});

test("カスタム provider では既存の key / memo / resync API が 400 になり、DB 行を作らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      pi.modelRuntimeCalls.length = 0;

      const putKey = await bff.app.request(
        "/api/settings/models/local-llm/key",
        jsonRequest("PUT", { apiKey: NEW_KEY }),
      );
      assert.equal(putKey.status, 400);
      assert.equal((await jsonBody(putKey)).error, CUSTOM_PROVIDER_KEY_TARGET_MESSAGE);

      const deleteKey = await bff.app.request("/api/settings/models/local-llm/key", jsonRequest("DELETE"));
      assert.equal(deleteKey.status, 400);
      assert.equal((await jsonBody(deleteKey)).error, CUSTOM_PROVIDER_KEY_TARGET_MESSAGE);

      const putMemo = await bff.app.request(
        "/api/settings/models/local-llm/memo",
        jsonRequest("PUT", { memo: "メモ" }),
      );
      assert.equal(putMemo.status, 400);
      assert.equal((await jsonBody(putMemo)).error, CUSTOM_PROVIDER_MEMO_TARGET_MESSAGE);

      const resync = await bff.app.request("/api/settings/models/local-llm/resync", jsonRequest("POST"));
      assert.equal(resync.status, 400);
      assert.equal((await jsonBody(resync)).error, CUSTOM_PROVIDER_RESYNC_TARGET_MESSAGE);

      assert.deepEqual(pi.modelRuntimeCalls, [], "拒否したら SDK を触らない");
      assert.equal(countRows(dir, "provider_credentials"), 0);
      assert.equal(countRows(dir, "provider_memos"), 0);
    } finally {
      await bff.close();
    }
  });
});

test("キー適用に失敗したら 503 { error } を返し、not_stored を付けず登録も残さない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(
      stubOptions({
        onSetRuntimeApiKey: () => {
          throw new Error(`failed with ${KEY}`);
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const response = await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.deepEqual(body, { error: CUSTOM_PROVIDER_APPLY_FAILED_MESSAGE }, "not_stored を付けない");
      assert.ok(!JSON.stringify(body).includes(KEY), "SDK の生の文言を応答へ出さない");

      const get = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.deepEqual(get.customProviders, []);
      assert.equal(
        pi.modelRuntimeCalls.some((call) => call.operation === "unregisterProvider"),
        true,
        "登録を巻き戻す",
      );
    } finally {
      await bff.close();
    }
  });
});

test("ランタイム無しのカスタム操作は 503 { error } で、GET は空の customProviders を返す", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const get = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(get.runtimeAvailable, false);
      assert.deepEqual(get.customProviders, []);

      const response = await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      assert.equal(response.status, 503);
      assert.deepEqual(await jsonBody(response), { error: CUSTOM_PROVIDER_RUNTIME_UNAVAILABLE_MESSAGE });
    } finally {
      await bff.close();
    }
  });
});

test("作成はロックで直列化され、後から来た作成はキー適用の完了を待つ", async () => {
  await withStoreDir(async (dir) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = 0;
    const pi = createStubPi(
      stubOptions({
        onSetRuntimeApiKey: async () => {
          blocked += 1;
          if (blocked === 1) await gate;
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      let secondDone = false;
      const first = bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      const second = Promise.resolve(
        bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf({ id: "lab" }))),
      ).then((response: Response) => {
        secondDone = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondDone, false, "1 件目の適用中は 2 件目が完了しない");
      release?.();
      assert.equal((await first).status, 200);
      assert.equal((await second).status, 200);
      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => `${call.operation}:${call.provider}`),
        ["registerProvider:local-llm", "setRuntimeApiKey:local-llm", "registerProvider:lab", "setRuntimeApiKey:lab"],
      );
    } finally {
      await bff.close();
    }
  });
});

test("models.json の provider id が custom でも、既存のキー / メモ API がカスタム API に食われない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions({ providers: [{ provider: "custom", name: "Custom (models.json)" }] }));
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const putKey = await bff.app.request("/api/settings/models/custom/key", jsonRequest("PUT", { apiKey: KEY }));
      assert.equal(putKey.status, 200, "generic key API に届く");
      assert.equal((await jsonBody(putKey)).state, "applied");

      const putMemo = await bff.app.request("/api/settings/models/custom/memo", jsonRequest("PUT", { memo: "メモ" }));
      assert.equal(putMemo.status, 200, "generic memo API に届く");

      const deleteKey = await bff.app.request("/api/settings/models/custom/key", jsonRequest("DELETE"));
      assert.equal(deleteKey.status, 200, "generic key API の削除に届く");

      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => call.operation),
        ["setRuntimeApiKey", "removeRuntimeApiKey"],
      );

      // 同じ id のカスタム定義は既存 provider との衝突で 400（カスタム API の名前空間とは別）
      const created = await bff.app.request(
        "/api/settings/custom-providers",
        jsonRequest("POST", bodyOf({ id: "custom" })),
      );
      assert.equal(created.status, 400);
      assert.equal((await jsonBody(created)).error, CUSTOM_PROVIDER_ID_CONFLICT_MESSAGE);
    } finally {
      await bff.close();
    }
  });
});

test("孤立したキー / メモの行がある id では作成を 400 にし、その行は通常の API から削除できる", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      try {
        raw
          .prepare("INSERT INTO provider_credentials (provider, apiKey, updatedAt) VALUES (?, ?, ?)")
          .run("local-llm", KEY, Date.now());
        raw.prepare("INSERT INTO provider_memos (provider, memo) VALUES (?, ?)").run("lab", "以前のメモ");
      } finally {
        raw.close();
      }

      for (const id of ["local-llm", "lab"]) {
        const response = await bff.app.request(
          "/api/settings/custom-providers",
          jsonRequest("POST", bodyOf({ id, model: { id: "m", contextWindow: 1024 } })),
        );
        assert.equal(response.status, 400, `${id} は孤立行があるため作れない`);
        assert.equal((await jsonBody(response)).error, CUSTOM_PROVIDER_STORED_ROWS_MESSAGE);
      }
      assert.deepEqual(pi.modelRuntimeCalls, [], "作成を拒否したら SDK を触らない");

      // 孤立行は通常のプロバイダー一覧（カタログ外）から削除できる
      const get = await jsonBody(await bff.app.request("/api/settings/models"));
      const orphanKey = get.providers.find((entry: any) => entry.provider === "local-llm");
      const orphanMemo = get.providers.find((entry: any) => entry.provider === "lab");
      assert.equal(orphanKey?.orphan, true);
      assert.equal(orphanKey?.managed, true);
      assert.equal(orphanMemo?.memo, "以前のメモ");

      const deleteKey = await bff.app.request("/api/settings/models/local-llm/key", jsonRequest("DELETE"));
      assert.equal(deleteKey.status, 200, "孤立キー行を画面から削除できる");
      const clearMemo = await bff.app.request("/api/settings/models/lab/memo", jsonRequest("PUT", { memo: "" }));
      assert.equal(clearMemo.status, 200, "孤立メモ行を画面から削除できる");

      // 行が消えたら同じ id で登録できる
      const retried = await bff.app.request(
        "/api/settings/custom-providers",
        jsonRequest("POST", bodyOf({ id: "local-llm" })),
      );
      assert.equal(retried.status, 200);
    } finally {
      await bff.close();
    }
  });
});

test("probe は 200 で分類とモデル一覧を返し、state もキーも載せない", async () => {
  await withStoreDir(async (dir) => {
    const requests: Request[] = [];
    const probeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [{ id: "qwen2.5-coder:7b" }, { id: "llama3:8b" }] });
    }) as typeof fetch;
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: null,
      customProviderProbeFetch: probeFetch,
    });
    try {
      const created = await bff.app.request("/api/settings/custom-providers", jsonRequest("POST", bodyOf()));
      assert.equal(created.status, 200);

      // 作成済みの provider は、キーの空欄で保存済みのキーを使える
      const storedKey = await bff.app.request(
        "/api/settings/custom-providers/probe",
        jsonRequest("POST", { provider: "local-llm", baseUrl: "http://192.0.2.10:11434/v1", apiKey: "" }),
      );
      assert.equal(storedKey.status, 200);
      const storedBody = await jsonBody(storedKey);
      assert.deepEqual(storedBody.models, [{ id: "llama3:8b" }, { id: "qwen2.5-coder:7b" }]);
      assert.equal(storedBody.failure, null);
      assert.equal(storedBody.message, null);
      assert.equal("state" in storedBody, false, "probe は設定を変えないので state を持たない");
      assert.ok(!JSON.stringify(storedBody).includes(KEY), "probe の応答にキーを載せない");
      assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${KEY}`);

      // 未保存の下書きも、キーを渡せば同じ経路で確認できる
      const draft = await bff.app.request(
        "/api/settings/custom-providers/probe",
        jsonRequest("POST", { baseUrl: "http://192.0.2.10:11434/v1/", apiKey: NEW_KEY }),
      );
      assert.equal(draft.status, 200);
      assert.equal(requests[1]?.headers.get("authorization"), `Bearer ${NEW_KEY}`);
      assert.equal(new URL(requests[1]!.url).pathname, "/v1/models");
    } finally {
      await bff.close();
    }
  });
});

test("probe の失敗は 200 の分類で返し、入力の誤りだけ 400 にする", async () => {
  await withStoreDir(async (dir) => {
    const probeFetch = (async () => Response.json({ error: "no" }, { status: 401 })) as typeof fetch;
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: null,
      customProviderProbeFetch: probeFetch,
    });
    try {
      const unauthorized = await bff.app.request(
        "/api/settings/custom-providers/probe",
        jsonRequest("POST", { baseUrl: "http://192.0.2.10:11434/v1", apiKey: KEY }),
      );
      assert.equal(unauthorized.status, 200);
      const body = await jsonBody(unauthorized);
      assert.equal(body.failure, "unauthorized");
      assert.equal(body.httpStatus, 401);
      assert.deepEqual(body.models, []);
      assert.ok(typeof body.message === "string" && body.message.length > 0);

      for (const payload of [
        { provider: "ghost", baseUrl: "http://192.0.2.10:11434/v1", apiKey: KEY },
        { baseUrl: "http://192.0.2.10:11434/v1" },
        { baseUrl: "file:///etc/passwd", apiKey: KEY },
        { baseUrl: 42, apiKey: KEY },
      ]) {
        const response = await bff.app.request("/api/settings/custom-providers/probe", jsonRequest("POST", payload));
        assert.equal(response.status, 400, JSON.stringify(payload));
      }
    } finally {
      await bff.close();
    }
  });
});

test("GET /api/settings/models は probe の fetch を呼ばない", async () => {
  await withStoreDir(async (dir) => {
    let calls = 0;
    const probeFetch = (async () => {
      calls += 1;
      return Response.json({ data: [] });
    }) as typeof fetch;
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: null,
      customProviderProbeFetch: probeFetch,
    });
    try {
      const response = await bff.app.request("/api/settings/models");
      assert.equal(response.status, 200);
      assert.equal(calls, 0);
    } finally {
      await bff.close();
    }
  });
});
