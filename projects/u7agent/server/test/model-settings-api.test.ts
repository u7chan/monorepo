// 設定 → モデルの HTTP 契約 (GET / PUT / DELETE / resync / 起動適用)。実 API は呼ばず stub pi で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import {
  MODEL_CATALOG_ERROR_OFFLINE,
  MODEL_CATALOG_ERROR_PARTIAL,
  MODEL_CATALOG_ERROR_TIMEOUT,
  MODEL_CATALOG_ERROR_UNKNOWN,
} from "../src/model-settings";
import {
  PROVIDER_API_KEY_MIN_LENGTH,
  PROVIDER_MEMO_MAX_LENGTH,
  RUNTIME_MODELS_UNAVAILABLE_MESSAGE,
  type RuntimeModelsResponse,
} from "../src/schema";
import { asPiBff, createStubPi, STUB_MODEL, STUB_PLAIN_MODEL, waitFor, type StubPiOptions } from "./stub-pi";

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
      assert.equal(
        typeof put.providers.find((provider: any) => provider.provider === "anthropic")?.keyUpdatedAt,
        "number",
        "登録応答に保存日時 (epoch ms) を載せる",
      );
      assert.ok(!JSON.stringify(put).includes(KEY), "登録応答にキー値を載せない");

      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(response.runtimeAvailable, true);
      const byProvider = new Map<string, any>(response.providers.map((provider: any) => [provider.provider, provider]));
      assert.equal(byProvider.get("anthropic")?.managed, true);
      assert.equal(typeof byProvider.get("anthropic")?.keyUpdatedAt, "number");
      assert.equal(byProvider.get("local")?.keyUpdatedAt, null, "行の無い provider は保存日時なし");
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

test("移行前のキー行は keyUpdatedAt: null で返り、上書き保存で日時が入る", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      // v6 からの移行直後と同じ形 (updatedAt が NULL) を DB へ直接作る
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw
        .prepare("INSERT INTO provider_credentials (provider, apiKey, updatedAt) VALUES (?, ?, NULL)")
        .run("anthropic", KEY);
      raw.close();

      const before = await jsonBody(await bff.app.request("/api/settings/models"));
      const migrated = before.providers.find((provider: any) => provider.provider === "anthropic");
      assert.equal(migrated.managed, true);
      assert.equal(migrated.keyUpdatedAt, null, "移行前の行は保存日不明");

      const at = Date.now();
      const put = await jsonBody(await bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY })));
      const saved = put.providers.find((provider: any) => provider.provider === "anthropic")?.keyUpdatedAt;
      assert.equal(typeof saved, "number", "上書き保存で日時が入る");
      assert.ok(saved >= at);
      assert.ok(!JSON.stringify(put).includes(KEY));
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

      const memo = await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({ memo: "メモ" }));
      assert.equal(memo.status, 503);
      assert.equal((await jsonBody(memo)).state, "not_stored");
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

test("メモを含む DB 例外が応答・health・ログに現れない", async () => {
  await withStoreDir(async (dir) => {
    const memo = "review-memo-sensitive-text";
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      // SQLite の例外文言にメモ値が載る経路を作り、DB エラー境界を通す
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec(
        `CREATE TRIGGER memo_failure BEFORE INSERT ON provider_memos
         BEGIN SELECT RAISE(ABORT, 'boom ' || NEW.memo); END`,
      );
      raw.close();

      const response = await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({ memo }));
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.equal(body.state, "not_stored");
      assert.equal(body.error, "メモをアプリデータ（SQLite）へ保存できませんでした");
      assert.ok(!JSON.stringify(body).includes(memo), "応答本文にメモを出さない");

      const health = await jsonBody(await bff.app.request("/api/health"));
      assert.equal(health.appDb.ok, false);
      assert.equal(health.appDb.error, "provider memo query failed", "health へ載る保持エラーも固定文言にする");
      assert.ok(!health.appDb.error.includes(memo), `health にメモを出さない: ${health.appDb.error}`);

      assert.ok(!logged.join("\n").includes(memo), `ログにもメモを出さない: ${logged.join("\n")}`);
      assert.ok(logged.join("\n").includes("provider memo save failed: anthropic"), "操作の分類だけを残す");
      assert.ok(logged.join("\n").includes("provider memo query failed"), "固定文言だけを残す");
    } finally {
      console.warn = original.warn;
      console.error = original.error;
      await bff.close();
    }
  });
});

// --- provider メモ (PUT /api/settings/models/:provider/memo) ---

test("PUT memo は trim して保存し、応答と GET に載せて SDK を呼ばない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = pi.refreshCount;
      const saved = await jsonBody(
        await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({ memo: "  個人アカウントの本番キー  " })),
      );
      assert.equal(saved.state, "applied");
      const entry = saved.providers.find((provider: any) => provider.provider === "anthropic");
      assert.equal(entry.memo, "個人アカウントの本番キー", "trim して保存する");
      assert.equal(entry.managed, false, "メモの保存でキーの行を作らない");
      assert.equal(entry.degraded, undefined);
      assert.deepEqual(pi.modelRuntimeCalls, [], "SDK を呼ばない");
      assert.equal(pi.refreshCount, before, "公開 state を再計算しない");

      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(
        response.providers.find((provider: any) => provider.provider === "anthropic").memo,
        "個人アカウントの本番キー",
      );

      // キーを登録できない provider (ambient / keyless) にもメモは書ける
      const keyless = await jsonBody(
        await bff.app.request("/api/settings/models/local/memo", jsonPut({ memo: "ローカルの控え" })),
      );
      assert.equal(keyless.state, "applied");
      assert.equal(keyless.providers.find((provider: any) => provider.provider === "local").memo, "ローカルの控え");

      // 空にして保存すると行が消え、null に戻る
      const cleared = await jsonBody(
        await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({ memo: "" })),
      );
      assert.equal(cleared.providers.find((provider: any) => provider.provider === "anthropic").memo, null);
    } finally {
      await bff.close();
    }
  });
});

test("PUT memo は長さ超過を route の zod で 400 にし、対象外 provider も 400 にする", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const tooLong = await bff.app.request(
        "/api/settings/models/anthropic/memo",
        jsonPut({ memo: "a".repeat(PROVIDER_MEMO_MAX_LENGTH + 1) }),
      );
      assert.equal(tooLong.status, 400, "service は長さを見ないので route の zod が止める");
      assert.deepEqual(await jsonBody(tooLong), { error: "Invalid request body" });

      const unknown = await bff.app.request("/api/settings/models/openai/memo", jsonPut({ memo: "メモ" }));
      assert.equal(unknown.status, 400);
      assert.match((await jsonBody(unknown)).error, /メモは保存できません/);

      const shape = await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({}));
      assert.equal(shape.status, 400);

      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(response.providers.find((provider: any) => provider.provider === "anthropic").memo, null);
    } finally {
      await bff.close();
    }
  });
});

test("保存したメモは再起動後も残り、SDK へ適用されない", async () => {
  await withStoreDir(async (dir) => {
    const first = createStubPi(stubOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(first), workspace: null });
    await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({ memo: "個人アカウントの控え" }));
    await bff.close();

    const second = createStubPi(stubOptions());
    const restarted = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(second),
      workspace: null,
    });
    try {
      assert.deepEqual(second.modelRuntimeCalls, [], "メモは認証 overlay に関わらない");
      const response = await jsonBody(await restarted.app.request("/api/settings/models"));
      const entry = response.providers.find((provider: any) => provider.provider === "anthropic");
      assert.equal(entry.memo, "個人アカウントの控え");
      assert.equal(entry.managed, false);
    } finally {
      await restarted.close();
    }
  });
});

test("ランタイム無しのメモ保存は 503 not_stored", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const put = await bff.app.request("/api/settings/models/anthropic/memo", jsonPut({ memo: "メモ" }));
      assert.equal(put.status, 503);
      assert.deepEqual(await jsonBody(put), {
        error: "ランタイムが利用できないため、メモを保存できません",
        state: "not_stored",
      });
    } finally {
      await bff.close();
    }
  });
});

// --- 利用可能なモデル / アプリ既定モデル (PUT /api/settings/models/allowed) ---

// API の許可リストは "provider/model" の文字列
const CATALOG_LABEL = "stub/stub-model";

function catalogOptions(): StubPiOptions {
  return stubOptions({ catalogModels: [STUB_MODEL, STUB_PLAIN_MODEL] });
}

test("PUT allowed は保存値を正規化して返し、setter → refresh を 1 回ずつ通す", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(catalogOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = pi.refreshCount;
      const saved = await jsonBody(
        await bff.app.request(
          "/api/settings/models/allowed",
          jsonPut({ allowedModels: [CATALOG_LABEL, CATALOG_LABEL], defaultModel: CATALOG_LABEL }),
        ),
      );
      assert.equal(saved.state, "applied");
      assert.deepEqual(saved.allowedModels, [CATALOG_LABEL], "重複は正規化する");
      assert.equal(saved.defaultModel, CATALOG_LABEL);
      assert.deepEqual(pi.modelSelections.at(-1), {
        allowedModels: [{ provider: "stub", id: "stub-model" }],
        defaultModel: { provider: "stub", id: "stub-model" },
      });
      assert.equal(pi.refreshCount, before + 1, "保存 1 回で再計算は 1 回");
      assert.equal(pi.modelStateEvents.at(-1), "refresh");
      assert.equal(pi.modelStateEvents.at(-2), "set", "setter が refresh より先");

      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.deepEqual(response.allowedModels, [CATALOG_LABEL]);
      assert.equal(response.defaultModel, CATALOG_LABEL);
    } finally {
      await bff.close();
    }
  });
});

test("PUT allowed は保存値を再起動後も維持し、起動時に適用する", async () => {
  await withStoreDir(async (dir) => {
    const first = createStubPi(catalogOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(first), workspace: null });
    await bff.app.request(
      "/api/settings/models/allowed",
      jsonPut({ allowedModels: ["stub/stub-plain"], defaultModel: null }),
    );
    await bff.close();

    const second = createStubPi(catalogOptions());
    const restarted = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(second),
      workspace: null,
    });
    try {
      assert.deepEqual(second.modelSelections, [
        { allowedModels: [{ provider: "stub", id: "stub-plain" }], defaultModel: undefined },
      ]);
      assert.equal(second.modelStateEvents.at(-1), "refresh");
      const response = await jsonBody(await restarted.app.request("/api/settings/models"));
      assert.deepEqual(response.allowedModels, ["stub/stub-plain"]);
      assert.equal(response.defaultModel, null);
    } finally {
      await restarted.close();
    }
  });
});

test("PUT allowed は未設定へ戻すと行を消し、両方 null を返す", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(catalogOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request(
        "/api/settings/models/allowed",
        jsonPut({ allowedModels: [CATALOG_LABEL], defaultModel: CATALOG_LABEL }),
      );
      const cleared = await jsonBody(
        await bff.app.request("/api/settings/models/allowed", jsonPut({ allowedModels: null, defaultModel: null })),
      );
      assert.equal(cleared.state, "applied");
      assert.equal(cleared.allowedModels, null);
      assert.equal(cleared.defaultModel, null);
      assert.deepEqual(pi.modelSelections.at(-1), { allowedModels: undefined, defaultModel: undefined });
    } finally {
      await bff.close();
    }
  });
});

test("PUT allowed はカタログ外と既定が許可外を 400 にし、何も保存しない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(catalogOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const outside = await bff.app.request(
        "/api/settings/models/allowed",
        jsonPut({ allowedModels: ["stub/ghost"], defaultModel: null }),
      );
      assert.equal(outside.status, 400);
      assert.match((await jsonBody(outside)).error, /カタログに無いモデル/);
      // 起動適用の 1 件だけが記録され、400 の保存は setter を呼ばない
      const selections = pi.modelSelections.length;

      const defaultOutside = await bff.app.request(
        "/api/settings/models/allowed",
        jsonPut({ allowedModels: [CATALOG_LABEL], defaultModel: "stub/stub-plain" }),
      );
      assert.equal(defaultOutside.status, 400);
      assert.match((await jsonBody(defaultOutside)).error, /既定モデルは利用可能なモデルから/);

      const shape = await bff.app.request(
        "/api/settings/models/allowed",
        jsonPut({ allowedModels: null, defaultModel: "stub-model" }),
      );
      assert.equal(shape.status, 400);

      const response = await jsonBody(await bff.app.request("/api/settings/models"));
      assert.equal(response.allowedModels, null);
      assert.equal(response.defaultModel, null);
      assert.equal(pi.modelSelections.length, selections, "400 の保存は公開 state へ触らない");
    } finally {
      await bff.close();
    }
  });
});

test("PUT allowed はランタイム無しで 503 not_stored、アプリ DB 不通でも 503 not_stored", async () => {
  await withStoreDir(async (dir) => {
    const withoutRuntime = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await withoutRuntime.app.request(
        "/api/settings/models/allowed",
        jsonPut({ allowedModels: null, defaultModel: null }),
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await jsonBody(response), {
        error: "ランタイムが利用できないため、利用可能なモデルを変更できません",
        state: "not_stored",
      });
    } finally {
      await withoutRuntime.close();
    }

    // 会話ストアのパスに通常ファイルを指すと、DB を開く前に使えないと分かる
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "x");
    const withoutDb = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: filePath,
      pi: asPiBff(createStubPi(catalogOptions())),
      workspace: null,
    });
    try {
      const put = await withoutDb.app.request(
        "/api/settings/models/allowed",
        jsonPut({ allowedModels: null, defaultModel: null }),
      );
      assert.equal(put.status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");
    } finally {
      await withoutDb.close();
    }
  });
});

test("GET は設定されていても無視する環境変数名を返す", async () => {
  await withStoreDir(async (dir) => {
    const names = ["PI_MODELS", "PI_MODEL", "PI_PROVIDER"] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    process.env.PI_MODELS = "stub/stub-model";
    process.env.PI_MODEL = "stub/stub-plain";
    delete process.env.PI_PROVIDER;
    try {
      const bff = await createBffApp({
        cwd: "/tmp/project",
        sessionStoreDir: dir,
        pi: asPiBff(createStubPi(catalogOptions())),
        workspace: null,
      });
      try {
        const response = await jsonBody(await bff.app.request("/api/settings/models"));
        assert.deepEqual(response.ignoredEnvironmentVariables, ["PI_MODELS", "PI_MODEL"]);
        // 無視されるので、許可リストは未設定のまま (環境変数は保存値に影響しない)
        assert.equal(response.allowedModels, null);
      } finally {
        await bff.close();
      }
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

test("壊れた model_settings は制限なしで起動し、health と設定 API に失敗を残す", async () => {
  await withStoreDir(async (dir) => {
    const first = createStubPi(catalogOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(first), workspace: null });
    await bff.app.request(
      "/api/settings/models/allowed",
      jsonPut({ allowedModels: ["stub/stub-model"], defaultModel: "stub/stub-model" }),
    );
    await bff.close();

    // 保存値だけを壊す (v5 の実ファイルを直接編集した状態)
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    raw.prepare("UPDATE model_settings SET allowedModels = ?").run("not json");
    raw.close();

    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    const restarted = createStubPi(catalogOptions());
    let reopened: Awaited<ReturnType<typeof createBffApp>>;
    try {
      reopened = await createBffApp({
        cwd: "/tmp/project",
        sessionStoreDir: dir,
        pi: asPiBff(restarted),
        workspace: null,
      });
    } finally {
      console.warn = original.warn;
      console.error = original.error;
    }
    try {
      assert.ok(logged.join("\n").includes("model settings unavailable"), "起動ログに警告を残す");
      assert.deepEqual(restarted.modelSelections, [], "読めなかった側は写さず、制限なしで続行する");
      assert.equal(restarted.modelStateEvents.at(-1), "refresh", "最後の再計算は行う");

      const health = await jsonBody(await reopened.app.request("/api/health"));
      assert.equal(health.appDb.ok, false, "health の appDb が失敗を示す");
      assert.match(health.appDb.error, /model_settings\.allowedModels/);

      const response = await reopened.app.request("/api/settings/models");
      assert.equal(response.status, 503, "設定 API は同じ行で 503 になる");

      // 別テーブルだけを使う API は動き続け、その成功で health の失敗が消えない
      assert.equal((await reopened.app.request("/api/projects")).status, 200);
      const again = await jsonBody(await reopened.app.request("/api/health"));
      assert.equal(again.appDb.ok, false, "別テーブルの読取成功で失敗状態を消さない");
    } finally {
      await reopened.close();
    }
  });
});

// --- カタログの手動更新 (POST /api/settings/models/catalog/refresh) ---

/** pi.dev の取得結果として返す固定の一覧。実カタログは pi.dev 側に依存するため、形と契約だけを固定する */
const RUNTIME_CATALOG: RuntimeModelsResponse = {
  catalogCount: 2,
  availableCount: 1,
  versions: { piCodingAgent: "1.0.0" },
  providers: [
    {
      provider: "stub",
      auth: { configured: true, source: "environment", environmentVariables: [] },
      models: [
        { id: "stub-model", name: "Stub Model", available: true },
        { id: "stub-plain", name: "Stub Plain", available: false },
      ],
    },
  ],
};

const refreshRequest = (): RequestInit => ({ method: "POST" });

test("POST catalog/refresh は allowNetwork / force 付きで 1 回取得し、更新後のカタログを返す", async () => {
  await withStoreDir(async (dir) => {
    const after: RuntimeModelsResponse = { ...RUNTIME_CATALOG, catalogCount: 3, availableCount: 2 };
    const pi = createStubPi(
      stubOptions({
        modelCatalog: RUNTIME_CATALOG,
        onRefreshModelCatalog: () => {
          // 実 SDK は取得できた provider を overlay へ写す。公開 state の再計算後に読む値をここで差し替える
          pi.setModelCatalog(after);
          return { aborted: false, failedProviders: 0 };
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = pi.refreshCount;
      const response = await jsonBody(await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest()));
      assert.equal(response.catalogError, null);
      assert.equal(response.catalogCount, 3, "更新後の一覧を返す");
      assert.deepEqual(
        pi.catalogRefreshCalls.map((call) => [call.allowNetwork, call.force]),
        [[true, true]],
        "SDK へ allowNetwork / force を明示して 1 回だけ呼ぶ",
      );
      assert.equal(pi.refreshCount, before + 1, "取得の後で公開 state を 1 回だけ再計算する");
    } finally {
      await bff.close();
    }
  });
});

test("一部 provider の失敗は 200 と固定文言に寄せ、一覧は現在値のまま返す", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(
      stubOptions({
        modelCatalog: RUNTIME_CATALOG,
        onRefreshModelCatalog: () => ({ aborted: false, failedProviders: 1 }),
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const response = await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest());
      assert.equal(response.status, 200, "一部失敗でも 200 (一覧は返せる)");
      const body = await jsonBody(response);
      assert.equal(body.catalogError, MODEL_CATALOG_ERROR_PARTIAL);
      assert.equal(body.catalogCount, RUNTIME_CATALOG.catalogCount, "取得できた範囲の一覧を返す");
    } finally {
      await bff.close();
    }
  });
});

test("abort された取得は失敗扱いで現在の一覧を保つ", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(
      stubOptions({
        modelCatalog: RUNTIME_CATALOG,
        // SDK の refresh は期限で中断すると aborted: true を返す (例外にはしない)
        onRefreshModelCatalog: () => ({ aborted: true, failedProviders: 2 }),
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const body = await jsonBody(await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest()));
      assert.equal(body.catalogError, MODEL_CATALOG_ERROR_TIMEOUT);
      assert.equal(body.catalogCount, RUNTIME_CATALOG.catalogCount, "一覧は現在値のまま");
    } finally {
      await bff.close();
    }
  });
});

test("refresh の例外は固定文言になり、生の例外文言を応答へ出さない", async () => {
  await withStoreDir(async (dir) => {
    const raw = "ModelConfig.load failed: /root/.pi/agent/models.json";
    const pi = createStubPi(
      stubOptions({
        modelCatalog: RUNTIME_CATALOG,
        onRefreshModelCatalog: () => {
          throw new Error(raw);
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const body = await jsonBody(await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest()));
      assert.equal(body.catalogError, MODEL_CATALOG_ERROR_UNKNOWN);
      assert.ok(!JSON.stringify(body).includes("ModelConfig.load failed"), "生の例外文言を応答へ出さない");
      assert.equal(body.catalogCount, RUNTIME_CATALOG.catalogCount);
    } finally {
      await bff.close();
    }
  });
});

test("PI_OFFLINE では取得せず、現在の一覧と固定文言を返す", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(stubOptions({ modelCatalog: RUNTIME_CATALOG }));
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    const original = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    try {
      const body = await jsonBody(await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest()));
      assert.equal(body.catalogError, MODEL_CATALOG_ERROR_OFFLINE);
      assert.equal(body.catalogCount, RUNTIME_CATALOG.catalogCount, "一覧は返す");
      assert.deepEqual(pi.catalogRefreshCalls, [], "SDK の refresh は呼ばない");
    } finally {
      if (original === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = original;
      await bff.close();
    }
  });
});

test("カタログを返せないときは 503 (GET /api/runtime/models と同じ契約)", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi(catalogOptions());
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const response = await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest());
      assert.equal(response.status, 503);
      assert.deepEqual(await jsonBody(response), { error: RUNTIME_MODELS_UNAVAILABLE_MESSAGE });
    } finally {
      await bff.close();
    }
  });
});

test("ランタイム無しのカタログ更新は 503", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await bff.app.request("/api/settings/models/catalog/refresh", refreshRequest());
      assert.equal(response.status, 503);
      assert.deepEqual(await jsonBody(response), { error: RUNTIME_MODELS_UNAVAILABLE_MESSAGE });
    } finally {
      await bff.close();
    }
  });
});

test("カタログ更新と同時のキー変更 PUT は同じロックで直列化される", async () => {
  await withStoreDir(async (dir) => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pi = createStubPi(
      stubOptions({
        modelCatalog: RUNTIME_CATALOG,
        onRefreshModelCatalog: async () => {
          order.push("catalog:start");
          await gate;
          order.push("catalog:end");
          return { aborted: false, failedProviders: 0 };
        },
        onSetRuntimeApiKey: () => {
          order.push("key:apply");
        },
      }),
    );
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const refresh = bff.app.request("/api/settings/models/catalog/refresh", refreshRequest());
      await waitFor(() => order.includes("catalog:start"), 1000, "catalog refresh start");
      const put = bff.app.request("/api/settings/models/anthropic/key", jsonPut({ apiKey: KEY }));
      // 更新がロックを持っている間はキー変更が SDK へ入らない
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(order, ["catalog:start"]);
      release();
      assert.equal((await refresh).status, 200);
      assert.equal((await put).status, 200);
      assert.deepEqual(order, ["catalog:start", "catalog:end", "key:apply"]);
    } finally {
      release();
      await bff.close();
    }
  });
});
