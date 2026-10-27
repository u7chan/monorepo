// コンテンツ生成の設定 API（GET / PUT / PUT key / DELETE key）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { encryptedSecret, TEST_MASTER_KEY } from "./app-secret-fixture";
import { APP_DB_FILENAME } from "../src/app-db";
import { createBffApp } from "../src/app";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import { DEFAULT_IMAGE_MODEL } from "../src/content-settings";
import { IMAGE_PROVIDER_ID } from "../src/images";
import { bgmSettings } from "../src/bgm";
import { asPiBff, createStubPi } from "./stub-pi";

// アプリ DB の APIキー / Webhook URL は暗号化して保存する。このファイルの BFF には master key を立てて起動する
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

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
  const dir = await mkdtemp(join(tmpdir(), "u7agent-content-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 実 API を叩かせないための live カタログ stub。応答は固定で、取得側の時計も進めない */
const liveCatalogFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      data: [
        { id: CATALOG_MODEL, name: "FLUX.2 Max" },
        { id: DEFAULT_IMAGE_MODEL, name: "GPT Image 2" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** createBffApp の薄い包み。カタログ取得だけを stub に固定する */
const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({ ...options, imageCatalogFetch: liveCatalogFetch });

test("GET / PUT / DELETE の往復で設定が変わり、キーは応答に載らない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      const before = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(before.configured, false);
      assert.equal(before.provider, null);
      assert.equal(before.image.model, null);
      assert.equal(before.runtimeAvailable, true);
      assert.deepEqual(before.bgm, bgmSettings(false));
      assert.ok(before.image.models.length > 0, "カタログが空");
      // キー未設定では live を取りに行かないので、SDK 同梱カタログから始まる
      assert.equal(before.image.catalogSource, "sdk");
      assert.equal(before.image.fetchedAt, null);
      assert.ok(
        before.image.models.some(
          (model: any) => model.provider === IMAGE_PROVIDER_ID && model.id === DEFAULT_IMAGE_MODEL,
        ),
      );
      for (const model of before.image.models) {
        assert.deepEqual(Object.keys(model).sort(), ["id", "name", "provider"]);
      }

      // 行が無い状態の選択変更は 400（キー登録が先）
      const unset = bff.app.request(
        "/api/settings/content/image",
        jsonPut({ provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL }),
      );
      assert.equal((await unset).status, 400);

      // キー登録前の applyStored() が無効を注入している
      assert.equal(pi.contentGenerationEnabled, false);

      const put = await jsonBody(await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY })));
      assert.equal(put.state, "applied");
      assert.deepEqual(put.bgm, bgmSettings(true));
      assert.equal(put.configured, true);
      assert.equal(put.provider, IMAGE_PROVIDER_ID);
      assert.equal(put.image.model, DEFAULT_IMAGE_MODEL);
      assert.equal(put.image.catalogSource, "sdk", "キー保存では live を取りに行かない");
      assert.equal(put.image.fetchedAt, null);
      assert.ok(
        put.image.models.some((model: any) => model.id === DEFAULT_IMAGE_MODEL),
        "SDK 同梱の一覧を返す",
      );
      assert.ok(!JSON.stringify(put).includes(KEY), "応答にキーを載せない");
      assert.ok(pi.retainedSecrets.includes(KEY), "DB より前にマスカーへ登録していない");
      assert.equal(pi.contentGenerationEnabled, true, "次に作るセッション向けに即時反映する");
      const config = pi.contentGenerationConfigs.at(-1);
      assert.deepEqual(config?.read(), { provider: IMAGE_PROVIDER_ID, model: DEFAULT_IMAGE_MODEL, apiKey: KEY });

      const changed = await jsonBody(
        await bff.app.request(
          "/api/settings/content/image",
          jsonPut({ provider: IMAGE_PROVIDER_ID, model: CATALOG_MODEL }),
        ),
      );
      assert.equal(changed.state, "applied");
      assert.equal(changed.image.model, CATALOG_MODEL);
      assert.deepEqual(config?.read(), { provider: IMAGE_PROVIDER_ID, model: CATALOG_MODEL, apiKey: KEY });

      const after = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(after.configured, true);
      assert.equal(after.image.model, CATALOG_MODEL);
      assert.ok(!JSON.stringify(after).includes(KEY));

      const deleted = await jsonBody(await bff.app.request("/api/settings/content/key", { method: "DELETE" }));
      assert.equal(deleted.state, "applied");
      assert.equal(deleted.configured, false);
      assert.deepEqual(deleted.bgm, bgmSettings(false));
      assert.equal(deleted.provider, null);
      assert.equal(deleted.image.model, null);
      assert.equal(pi.contentGenerationEnabled, false);
      assert.equal(config?.read(), undefined, "execute が読む現在の設定も未設定へ戻る");
    } finally {
      await bff.close();
    }
  });
});

test("PUT /api/settings/content は有効 / 無効を切り替え、キーと選択を残す", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      // 行が無い = 止める対象が無い。キー登録が先
      const unset = bff.app.request("/api/settings/content", jsonPut({ enabled: false }));
      assert.equal((await unset).status, 400);

      const created = await jsonBody(await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY })));
      assert.equal(created.enabled, true, "キー登録で作る行は既定で有効");
      assert.equal(created.disabledMessage, CONTENT_DISABLED_MESSAGE);

      const off = await jsonBody(await bff.app.request("/api/settings/content", jsonPut({ enabled: false })));
      assert.equal(off.state, "applied");
      assert.equal(off.enabled, false);
      assert.equal(off.configured, true, "OFF でも未設定へは戻さない");
      assert.equal(off.image.model, DEFAULT_IMAGE_MODEL, "キーと選択は残る");
      assert.ok(!JSON.stringify(off).includes(KEY), "応答にキーを載せない");
      assert.equal(pi.contentGenerationEnabled, false, "次に作るセッションへ即時反映する");
      assert.equal(pi.contentGenerationConfigs.at(-1)?.configured, true, "停止の理由をキー未設定と書き分ける");

      const after = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(after.enabled, false);
      assert.equal(after.configured, true);
      assert.equal(after.image.model, DEFAULT_IMAGE_MODEL);

      const on = await jsonBody(await bff.app.request("/api/settings/content", jsonPut({ enabled: true })));
      assert.equal(on.enabled, true);
      assert.equal(pi.contentGenerationEnabled, true);

      const invalid = bff.app.request("/api/settings/content", jsonPut({ enabled: "yes" }));
      assert.equal((await invalid).status, 400);
    } finally {
      await bff.close();
    }
  });
});

test("入力と対象の検証: 短い / 長いキー、provider、カタログ外モデルは 400", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      for (const apiKey of ["short", "x".repeat(2049)]) {
        const response = bff.app.request("/api/settings/content/key", jsonPut({ apiKey }));
        assert.equal((await response).status, 400, `${apiKey.length} 文字のキーを受け付けている`);
      }
      assert.deepEqual(pi.retainedSecrets, [], "検証で落ちたキーはマスカーへ足さない");

      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      for (const body of [
        { provider: "openai", model: DEFAULT_IMAGE_MODEL },
        { provider: IMAGE_PROVIDER_ID, model: "ghost/model" },
      ]) {
        const response = bff.app.request("/api/settings/content/image", jsonPut(body));
        assert.equal((await response).status, 400, JSON.stringify(body));
      }
      const invalid = bff.app.request("/api/settings/content/image", jsonPut({ provider: IMAGE_PROVIDER_ID }));
      assert.equal((await invalid).status, 400);
    } finally {
      await bff.close();
    }
  });
});

test("カタログ外 model の 400 は登録済みキーを反射しない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      // 登録済みキーを model に誤って渡しても、エラー文言から再露出させない
      const response = bff.app.request(
        "/api/settings/content/image",
        jsonPut({ provider: IMAGE_PROVIDER_ID, model: KEY }),
      );
      assert.equal((await response).status, 400);
      const body = await jsonBody(response);
      assert.ok(!JSON.stringify(body).includes(KEY), `400 応答にキーを出さない: ${JSON.stringify(body)}`);
      assert.ok(body.error.includes("[REDACTED]"), `マスク済みの文言を返す: ${body.error}`);
      assert.ok(body.error.startsWith("カタログに無い画像モデルは指定できません"), "分類の文言は残す");
    } finally {
      await bff.close();
    }
  });
});

test("ランタイムが無いときの GET は runtimeAvailable: false、キー登録は 503 not_stored", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: null, workspace: null });
    try {
      const response = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(response.runtimeAvailable, false);
      assert.equal(response.configured, false);

      const put = bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      assert.equal((await put).status, 503);
      assert.deepEqual(await jsonBody(put), {
        error: "ランタイムが利用できないため、コンテンツ生成のAPIキーを登録できません",
        state: "not_stored",
      });
      const stored = await jsonBody(await bff.app.request("/api/settings/content"));
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
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: filePath,
      pi: asPiBff(pi),
      workspace: null,
    });
    try {
      const read = bff.app.request("/api/settings/content");
      assert.equal((await read).status, 503);

      const put = bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
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
    const first = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    await first.close();

    // 保存済みの行は暗号文だけを持つ (平文の列は無い)
    const secret = encryptedSecret("content_settings", "apiKey", KEY);
    const seed = new DatabaseSync(join(dir, APP_DB_FILENAME));
    seed
      .prepare(
        "INSERT INTO content_settings (id, provider, imageModel, ciphertext, nonce, keyVersion) VALUES (1, ?, ?, ?, ?, ?)",
      )
      .run(IMAGE_PROVIDER_ID, DEFAULT_IMAGE_MODEL, secret.ciphertext, secret.nonce, secret.keyVersion);
    seed.close();

    const pi = createStubPi();
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      assert.equal(pi.contentGenerationEnabled, true);
      assert.deepEqual(pi.contentGenerationConfigs.at(-1)?.read(), {
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
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      // SQLite の例外文言に暗号文 (hex) が載る経路を作り、値なし境界を通す
      const raw = new DatabaseSync(join(dir, APP_DB_FILENAME));
      raw.exec(
        `CREATE TRIGGER leak BEFORE DELETE ON content_settings
         BEGIN SELECT RAISE(ABORT, 'boom ' || hex(OLD.ciphertext)); END`,
      );
      raw.close();

      const response = await bff.app.request("/api/settings/content/key", { method: "DELETE" });
      assert.equal(response.status, 503);
      const body = await jsonBody(response);
      assert.equal(body.state, "not_stored");
      assert.ok(!JSON.stringify(body).includes(KEY), "応答本文にキーを出さない");

      const health = await jsonBody(await bff.app.request("/api/health"));
      assert.equal(health.appDb.ok, false);
      assert.ok(!health.appDb.error.includes(KEY), `health にキーを出さない: ${health.appDb.error}`);
      assert.equal(health.appDb.error, "app secret query failed");

      assert.ok(!logged.join("\n").includes(KEY), `ログにもキーを出さない: ${logged.join("\n")}`);
      assert.ok(logged.join("\n").includes("app secret query failed"), "操作の分類だけを残す");
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
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: OTHER_KEY }));
      assert.deepEqual(pi.retainedSecrets, [KEY, OTHER_KEY]);
      const response = await jsonBody(await bff.app.request("/api/settings/content"));
      assert.equal(response.image.model, DEFAULT_IMAGE_MODEL);
      assert.ok(!JSON.stringify(response).includes(OTHER_KEY));
    } finally {
      await bff.close();
    }
  });
});

test("モデル一覧の再取得は 200 で一覧を返し、失敗は catalogError にだけ載せる", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const refreshed = await jsonBody(
        await bff.app.request("/api/settings/content/image/catalog/refresh", { method: "POST" }),
      );
      assert.equal(refreshed.catalogError, null);
      assert.equal(refreshed.catalogSource, "live");
      assert.equal(typeof refreshed.fetchedAt, "number");
      assert.deepEqual(
        refreshed.models.map((model: any) => model.id),
        [CATALOG_MODEL, DEFAULT_IMAGE_MODEL],
      );
    } finally {
      await bff.close();
    }
  });

  await withStoreDir(async (dir) => {
    const bff = await createBffApp({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
      imageCatalogFetch: async () => new Response("boom", { status: 503 }),
    });
    try {
      const response = await bff.app.request("/api/settings/content/image/catalog/refresh", { method: "POST" });
      assert.equal(response.status, 200, "取得できなくても 200 で一覧を失わせない");
      const body = await jsonBody(response);
      assert.equal(body.catalogError, "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）");
      assert.equal(body.catalogSource, "sdk");
      assert.equal(body.fetchedAt, null);
      assert.ok(body.models.length > 0, "前の一覧を返す");
    } finally {
      await bff.close();
    }
  });
});
