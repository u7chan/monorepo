// 画像生成の設定 API（GET / PUT / PUT key / DELETE key）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import { DEFAULT_IMAGE_MODEL, IMAGE_PROVIDER_ID } from "../src/image-settings";
import { asPiBff, createStubPi } from "./stub-pi";

const KEY = "sk-image-dummy-key-0123456789abcdef";
const OTHER_KEY = "sk-image-other-key-0123456789";
const CATALOG_MODEL = "black-forest-labs/flux.2-max";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const jsonPut = (payload: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-image-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GET / PUT / DELETE の往復で設定が変わり、キーは応答に載らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = await jsonBody(await bff.app.request("/api/settings/images"));
      assert.equal(before.configured, false);
      assert.equal(before.provider, null);
      assert.equal(before.model, null);
      assert.equal(before.runtimeAvailable, true);
      assert.ok(before.models.length > 0, "カタログが空");
      assert.ok(
        before.models.some((model: any) => model.provider === IMAGE_PROVIDER_ID && model.id === DEFAULT_IMAGE_MODEL),
      );
      for (const model of before.models) {
        assert.deepEqual(Object.keys(model).sort(), ["id", "name", "provider"]);
      }

      // 行が無い状態の選択変更は 400（キー登録が先）
      const unset = bff.app.request(
        "/api/settings/images",
        jsonPut({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL }),
      );
      assert.equal((await unset).status, 400);

      // キー登録前の applyStored() が無効を注入している
      assert.equal(pi.imageGenerationEnabled, false);

      const put = await jsonBody(await bff.app.request("/api/settings/images/key", jsonPut({ apiKey: KEY })));
      assert.equal(put.state, "applied");
      assert.equal(put.configured, true);
      assert.equal(put.provider, IMAGE_PROVIDER_ID);
      assert.equal(put.model, DEFAULT_IMAGE_MODEL);
      assert.ok(!JSON.stringify(put).includes(KEY), "応答にキーを載せない");
      assert.ok(pi.retainedSecrets.includes(KEY), "DB より前にマスカーへ登録していない");
      assert.equal(pi.imageGenerationEnabled, true, "次に作るセッション向けに即時反映する");
      const config = pi.imageGenerationConfigs.at(-1);
      assert.deepEqual(config?.read(), { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY });

      const changed = await jsonBody(
        await bff.app.request("/api/settings/images", jsonPut({ provider: IMAGE_PROVIDER_ID, model: CATALOG_MODEL })),
      );
      assert.equal(changed.state, "applied");
      assert.equal(changed.model, CATALOG_MODEL);
      assert.deepEqual(config?.read(), { provider: IMAGE_PROVIDER_ID, model: CATALOG_MODEL, apiKey: KEY });

      const after = await jsonBody(await bff.app.request("/api/settings/images"));
      assert.equal(after.configured, true);
      assert.equal(after.model, CATALOG_MODEL);
      assert.ok(!JSON.stringify(after).includes(KEY));

      const deleted = await jsonBody(await bff.app.request("/api/settings/images/key", { method: "DELETE" }));
      assert.equal(deleted.state, "applied");
      assert.equal(deleted.configured, false);
      assert.equal(deleted.provider, null);
      assert.equal(deleted.model, null);
      assert.equal(pi.imageGenerationEnabled, false);
      assert.equal(config?.read(), undefined, "execute が読む現在の設定も未設定へ戻る");
    } finally {
      await bff.close();
    }
  });
});

test("入力と対象の検証: 短い / 長いキー、provider、カタログ外モデルは 400", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      for (const apiKey of ["short", "x".repeat(2049)]) {
        const response = bff.app.request("/api/settings/images/key", jsonPut({ apiKey }));
        assert.equal((await response).status, 400, `${apiKey.length} 文字のキーを受け付けている`);
      }
      assert.deepEqual(pi.retainedSecrets, [], "検証で落ちたキーはマスカーへ足さない");

      await bff.app.request("/api/settings/images/key", jsonPut({ apiKey: KEY }));
      for (const body of [
        { provider: "openai", model: DEFAULT_IMAGE_MODEL },
        { provider: IMAGE_PROVIDER_ID, model: "ghost/model" },
      ]) {
        const response = bff.app.request("/api/settings/images", jsonPut(body));
        assert.equal((await response).status, 400, JSON.stringify(body));
      }
      const invalid = bff.app.request("/api/settings/images", jsonPut({ provider: IMAGE_PROVIDER_ID }));
      assert.equal((await invalid).status, 400);
    } finally {
      await bff.close();
    }
  });
});

test("ランタイムが無いときの GET は runtimeAvailable: false、キー登録は 503 not_stored", async () => {
  await withStoreDir(async (dir) => {
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await jsonBody(await bff.app.request("/api/settings/images"));
      assert.equal(response.runtimeAvailable, false);
      assert.equal(response.configured, false);

      const put = bff.app.request("/api/settings/images/key", jsonPut({ apiKey: KEY }));
      assert.equal((await put).status, 503);
      assert.deepEqual(await jsonBody(put), {
        error: "ランタイムが利用できないため、画像APIキーを登録できません",
        state: "not_stored",
      });
      const stored = await jsonBody(await bff.app.request("/api/settings/images"));
      assert.equal(stored.configured, false, "失敗した登録を保存していない");
    } finally {
      await bff.close();
    }
  });
});

test("アプリ DB が使えないときは GET / 変更系とも 503 になる", async () => {
  await withStoreDir(async (dir) => {
    // 会話ストアのパスに通常ファイルを指すと、DB を開く前に使えないと分かる
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "x");
    const pi = createStubPi();
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: filePath,
      pi: asPiBff(pi),
      workspace: null,
    });
    try {
      const read = bff.app.request("/api/settings/images");
      assert.equal((await read).status, 503);

      const put = bff.app.request("/api/settings/images/key", jsonPut({ apiKey: KEY }));
      assert.equal((await put).status, 503);
      assert.equal((await jsonBody(put)).state, "not_stored");
    } finally {
      await bff.close();
    }
  });
});

test("起動時に保存行があればツールを有効化し、行が無ければ無効のままにする", async () => {
  await withStoreDir(async (dir) => {
    const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
    // createBffApp が DB を新規作成するため、先に schema 8 の DB を作ってから行を足す
    raw.close();
    const first = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    await first.close();

    const seed = new DatabaseSync(join(dir, APP_DB_FILENAME));
    seed
      .prepare("INSERT INTO image_settings (id, provider, model, apiKey) VALUES (1, ?, ?, ?)")
      .run(IMAGE_PROVIDER_ID, DEFAULT_IMAGE_MODEL, KEY);
    seed.close();

    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      assert.equal(pi.imageGenerationEnabled, true);
      assert.deepEqual(pi.imageGenerationConfigs.at(-1)?.read(), {
        provider: IMAGE_PROVIDER_ID,
        model: DEFAULT_IMAGE_MODEL,
        apiKey: KEY,
      });
      assert.ok(pi.retainedSecrets.includes(KEY), "起動時もマスカーへ登録する");
    } finally {
      await bff.close();
    }
  });
});

test("登録済みキーを含む DB 例外が応答・health・ログに現れない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await bff.app.request("/api/settings/images/key", jsonPut({ apiKey: KEY }));
      // SQLite の例外文言にキーが載る経路を作り、DB エラー境界を通す
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec(
        `CREATE TRIGGER leak BEFORE DELETE ON image_settings
         BEGIN SELECT RAISE(ABORT, 'boom ' || OLD.apiKey); END`,
      );
      raw.close();

      const response = await bff.app.request("/api/settings/images/key", { method: "DELETE" });
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

test("同じキーの上書き保存でもマスカーの登録は増えず、2 本目のキーは削除後も保護される", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await createBffApp({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/images/key", jsonPut({ apiKey: KEY }));
      await bff.app.request("/api/settings/images/key", jsonPut({ apiKey: OTHER_KEY }));
      assert.deepEqual(pi.retainedSecrets, [KEY, OTHER_KEY]);
      const response = await jsonBody(await bff.app.request("/api/settings/images"));
      assert.equal(response.model, DEFAULT_IMAGE_MODEL);
      assert.ok(!JSON.stringify(response).includes(OTHER_KEY));
    } finally {
      await bff.close();
    }
  });
});
