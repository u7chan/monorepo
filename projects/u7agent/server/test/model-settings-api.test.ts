// 設定 → モデルの HTTP 契約 (GET / PUT / DELETE / resync / 起動適用)。実 API は呼ばず stub pi で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import { PROVIDER_API_KEY_MIN_LENGTH } from "../src/schema";
import { asPiBff, createStubPi, type StubPiOptions } from "./stub-pi";

const KEY = "sk-ant-dummy-key-0123456789abcdef";
const OTHER_KEY = "sk-openai-dummy-key-0123456789";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

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
  const dir = await mkdtemp(join(tmpdir(), "u7agent-model-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GET はプロバイダーの認証状態と managed を返し、キー値は載せない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = pi.refreshCount;
      const put = await jsonBody(await bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY })));
      assert.equal(put.state, "applied");
      assert.ok(!JSON.stringify(put).includes(KEY), "登録応答にキー値を載せない");

      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(response.runtimeAvailable, true);
      const byProvider = new Map<string, any>(response.providers.map((provider: any) => [provider.provider, provider]));
      assert.equal(byProvider.get("anthropic")?.managed, true);
      assert.equal(byProvider.get("anthropic")?.canSetApiKey, true);
      assert.deepEqual(byProvider.get("anthropic")?.auth, {
        configured: true,
        source: "environment",
        environmentVariables: [],
      });
      assert.equal(byProvider.get("local")?.managed, false);
      assert.equal(byProvider.get("local")?.canSetApiKey, false);
      assert.ok(!JSON.stringify(response).includes(KEY), "GET にもキー値を載せない");
      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => call.operation),
        ["setRuntimeApiKey"],
      );
      assert.deepEqual(pi.retainedSecrets, [KEY]);
      assert.equal(pi.refreshCount, before + 1, "変更 1 回で state の再計算は 1 回");
    } finally {
      await bff.close();
    }
  });
});

test("PUT は入力と対象を検証し、対象外では SDK / DB を触らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const short = await bff.app.request(
        "/api/settings/models/anthropic/key",
        jsonPut({ apiKey: "a".repeat(PROVIDER_API_KEY_MIN_LENGTH - 1) }),
      );
      assert.equal(short.status, 400);

      const unknown = await bff.app.request("/api/settings/models/openai/key", jsonPut({ apiKey: KEY }));
      assert.equal(unknown.status, 400);

      const notSettable = await bff.app.request("/api/settings/models/local/key", jsonPut({ apiKey: KEY }));
      assert.equal(notSettable.status, 400);

      assert.deepEqual(pi.modelRuntimeCalls, []);
      assert.deepEqual(pi.retainedSecrets, []);
      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(
        response.providers.some((provider: any) => provider.managed),
        false,
      );
    } finally {
      await bff.close();
    }
  });
});

test("DELETE は登録行だけを消し、resync はカタログの provider を受ける", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY }));

      const missing = await bff.app.request("/api/settings/models/local/key", { method: "DELETE" });
      assert.equal(missing.status, 400, "この画面で登録していない provider は削除できない");

      const deleted = await jsonBody(await bff.app.request("/api/settings/models/anthropic/key", { method: "DELETE" }));
      assert.equal(deleted.state, "applied");
      assert.equal(deleted.providers.find((provider: any) => provider.provider === "anthropic")?.managed, false);

      const resynced = await jsonBody(
        await bff.app.request("/api/settings/models/anthropic/resync", { method: "POST" }),
      );
      assert.equal(resynced.state, "applied");
      assert.deepEqual(
        pi.modelRuntimeCalls.map((call) => call.operation),
        ["setRuntimeApiKey", "removeRuntimeApiKey", "removeRuntimeApiKey"],
        "resync は DB 行が無いので overlay の削除を再適用する",
      );

      const rejected = await bff.app.request("/api/settings/models/openai/resync", { method: "POST" });
      assert.equal(rejected.status, 400);
    } finally {
      await bff.close();
    }
  });
});

test("登録したキーは再起動後も残り、起動時に SDK へ再適用される", async () => {
  await withStoreDir(async (dir) => {
    const first = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(first), workspace: null });
    await bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY }));
    await bff.close();

    // 同じディレクトリを開き直す = 再起動。DB の行が起動適用される
    const second = createStubPi(stubOptions());
    const restarted = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(second),
      workspace: null,
    });
    try {
      assert.deepEqual(second.modelRuntimeCalls, [
        { operation: "setRuntimeApiKey", provider: "anthropic", apiKey: KEY },
      ]);
      assert.deepEqual(second.retainedSecrets, [KEY]);
      const response = await jsonBody(await restarted.app.request("/api/settings/models"));
      const anthropic = response.providers.find((provider: any) => provider.provider === "anthropic");
      assert.equal(anthropic.managed, true);
      assert.equal(anthropic.degraded, undefined);
    } finally {
      await restarted.close();
    }
  });
});

test("ランタイムが無いときの変更系は 503 not_stored、GET は runtimeAvailable: false", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(response.runtimeAvailable, false);
      assert.deepEqual(response.providers, []);

      const put = bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY }));
      assert.equal((await put).status, 503);
      assert.deepEqual(await jsonBody(put), {
        error: "ランタイムが利用できないため、APIキーを変更できません",
        state: "not_stored",
      });
    } finally {
      await bff.close();
    }
  });
});

test("アプリ DB が使えないときの設定 API は 503 になる", async () => {
  await withStoreDir(async (dir) => {
    // 会話ストアのパスに通常ファイルを指すと、DB を開く前に使えないと分かる
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "x");
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: filePath,
      pi: asPiBff(createStubPi(stubOptions())),
      workspace: null,
    });
    try {
      const response = await bff.app.request("/api/settings/models");
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.equal(typeof body.error, "string");
      assert.equal(body.state, undefined, "GET は state を持たない");

      const put = await bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY }));
      assert.equal(put.status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");
    } finally {
      await bff.close();
    }
  });
});

test("別 provider の登録は互いの行を壊さず、応答は両方を含む", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(
      stubOptions({
        providers: [
          { provider: "anthropic", name: "Anthropic" },
          { provider: "openai", name: "OpenAI" },
        ],
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const bodies = await Promise.all([
        bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY })),
        bff.app.request("/api/settings/models/openai/key", jsonPut({ apiKey: OTHER_KEY })),
      ]);
      for (const response of bodies) {
        assert.equal(response.status, 200);
      }
      // 各応答は自分の変更までを含み、最後の応答が両方を含む (公開はロック内で 1 参照ずつ差し替える)
      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.deepEqual(
        response.providers
          .filter((provider: any) => provider.managed)
          .map((provider: any) => provider.provider)
          .sort(),
        ["anthropic", "openai"],
      );
    } finally {
      await bff.close();
    }
  });
});

test("登録済みキーを含む DB 例外が応答・health・ログに現れない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY }));
      // SQLite の例外文言にキーが載る経路を作り、DB エラー境界を通す
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec(
        `CREATE TRIGGER leak BEFORE DELETE ON provider_credentials
         BEGIN SELECT RAISE(ABORT, 'boom ' || OLD.apiKey); END`,
      );
      raw.close();

      const response = await bff.app.request("/api/settings/models/anthropic/key", { method: "DELETE" });
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.equal(body.state, "not_stored");
      assert.ok(!JSON.stringify(body).includes(KEY), "応答本文にキーを出さない");

      const health = await jsonBody(await bff.app.request("/api/health"));
      assert.equal(health.appDb.ok, false);
      assert.ok(!health.appDb.error.includes(KEY), `health にキーを出さない: ${health.appDb.error}`);
      assert.ok(health.appDb.error.includes("[REDACTED]"), "health ではマスク済みの文言を出す");

      assert.ok(!logged.join("\n").includes(KEY), `ログにもキーを出さない: ${logged.join("\n")}`);
      assert.ok(logged.join("\n").includes("[REDACTED]"));
    } finally {
      console.warn = original.warn;
      console.error = original.error;
      await bff.close();
    }
  });
});
