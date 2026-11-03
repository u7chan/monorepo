// 試行ジョブの API（開始 / 取得 / 一覧 / キャンセル / 削除）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { createBffApp } from "../src/app";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import {
  CONTENT_TRIAL_DELETE_RUNNING_MESSAGE,
  CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE,
  CONTENT_TRIAL_NOT_FOUND_MESSAGE,
} from "../src/content-trials";
import { DEFAULT_IMAGE_MODEL } from "../src/content-settings";
import { IMAGE_PROVIDER_ID, type ImageGenerationInput, type ImageGenerationResult } from "../src/images";
import { asPiBff, createStubPi } from "./stub-pi";

// アプリ DB の APIキーは暗号化して保存する。このファイルの BFF には master key を立てて起動する
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const KEY = "sk-image-dummy-key-0123456789abcdef";
const MODEL = `${IMAGE_PROVIDER_ID}/${DEFAULT_IMAGE_MODEL}`;
const CATALOG_MODEL = "black-forest-labs/flux.2-max";

const jsonBody = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

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

async function withStoreDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "u7agent-content-trials-"));
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

const openBff = (options: Parameters<typeof createBffApp>[0] = {}) =>
  createBffApp({ ...options, imageCatalogFetch: liveCatalogFetch });

/** 生成の完了を 1 件ずつ制御する。signal は abort で観測する */
interface Pending {
  input: ImageGenerationInput;
  resolve: (result: ImageGenerationResult) => void;
  aborted: () => boolean;
}

function createImageHarness() {
  const pending: Pending[] = [];
  return {
    pending,
    onGenerateImage: (input: ImageGenerationInput) =>
      new Promise<ImageGenerationResult>((resolve) => {
        pending.push({ input, resolve, aborted: () => input.signal?.aborted === true });
      }),
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

test("開始 → 取得 → キャンセル → 削除の往復。APIキーは応答にも履歴にも載らない", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));

      const started = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat on a sofa" }),
      );
      assert.equal(started.status, 202);
      const created = await jsonBody(started);
      assert.equal(created.trial.state, "running");
      assert.equal(created.trial.model, MODEL);
      assert.equal(created.trial.prompt, "a cat on a sofa");
      assert.equal(created.trial.artifactState, "none");
      assert.equal(created.trial.keyEpoch, 0);
      assert.equal(created.trial.recorded, true);
      assert.equal(JSON.stringify(created).includes(KEY), false, "応答にキーを載せない");
      const id = created.trial.id as string;

      // 実行中は同じ種別をもう 1 本受け付けない
      const rejected = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a dog" }),
      );
      assert.equal(rejected.status, 409);

      // 実行中の削除は 409 で「先に中断してください」
      const deniedDelete = await bff.app.request(`/api/settings/content/trials/${id}`, { method: "DELETE" });
      assert.equal(deniedDelete.status, 409);
      assert.equal((await jsonBody(deniedDelete)).error, CONTENT_TRIAL_DELETE_RUNNING_MESSAGE);

      const got = await jsonBody(await bff.app.request(`/api/settings/content/trials/${id}`));
      assert.equal(got.trial.state, "running");

      const canceled = await bff.app.request(`/api/settings/content/trials/${id}/cancel`, { method: "POST" });
      assert.equal(canceled.status, 200);
      const canceledBody = await jsonBody(canceled);
      assert.equal(canceledBody.trial.state, "canceled");
      assert.equal(images.pending[0]?.aborted(), true, "キャンセルで provider の呼び出しを abort する");
      assert.equal(images.pending[0]?.input.apiKey, KEY, "生成器へはキーを渡す");

      // 遅れて届いた結果は捨て、状態を戻さない
      images.pending[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
      await until(() => true);
      const afterLate = await jsonBody(await bff.app.request(`/api/settings/content/trials/${id}`));
      assert.equal(afterLate.trial.state, "canceled");
      assert.equal(JSON.stringify(afterLate).includes(KEY), false);

      // 完了後のキャンセルは 409
      const lateCancel = await bff.app.request(`/api/settings/content/trials/${id}/cancel`, { method: "POST" });
      assert.equal(lateCancel.status, 409);

      const list = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image"));
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].state, "canceled");
      assert.equal(list.keyEpoch, 0);

      const removed = await bff.app.request(`/api/settings/content/trials/${id}`, { method: "DELETE" });
      assert.equal(removed.status, 200);
      assert.equal((await jsonBody(removed)).removed, 1);
      const missing = await bff.app.request(`/api/settings/content/trials/${id}`);
      assert.equal(missing.status, 404);
      assert.equal((await jsonBody(missing)).error, CONTENT_TRIAL_NOT_FOUND_MESSAGE);
    } finally {
      await bff.close();
    }
  });
});

test("成功は succeeded で所要時間が入り、すべて削除は終端だけを消す", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const created = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
        ),
      );
      images.pending[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
      await until(() => images.pending.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const list = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image"));
      assert.equal(list.items[0]?.state, "succeeded");
      assert.equal(list.items[0]?.failureCode, null);
      assert.equal(typeof list.items[0]?.durationMs, "number");
      assert.equal(list.items[0]?.id, created.trial.id);

      const removed = await jsonBody(await bff.app.request("/api/settings/content/trials", { method: "DELETE" }));
      assert.equal(removed.removed, 1);
      const empty = await jsonBody(await bff.app.request("/api/settings/content/trials"));
      assert.deepEqual(empty.items, []);
    } finally {
      await bff.close();
    }
  });
});

test("キー未設定 / OFF / カタログ外モデルは課金前に止め、キー削除後も履歴は読める", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      // 未設定では開始できない（履歴の一覧は空で返る）
      const unset = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(unset.status, 400);
      assert.deepEqual((await jsonBody(await bff.app.request("/api/settings/content/trials"))).items, []);

      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));

      // カタログ外のモデルは 400
      const outside = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: `${IMAGE_PROVIDER_ID}/nope/model`, prompt: "a cat" }),
      );
      assert.equal(outside.status, 400);
      assert.match((await jsonBody(outside)).error, new RegExp(CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE));

      // 全体 OFF では新規生成を止める
      await bff.app.request("/api/settings/content", jsonPut({ enabled: false }));
      const disabled = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(disabled.status, 400);
      assert.equal((await jsonBody(disabled)).error, CONTENT_DISABLED_MESSAGE);
      await bff.app.request("/api/settings/content", jsonPut({ enabled: true }));

      const created = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
        ),
      );
      images.pending[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // キーを消しても履歴は残り、閲覧・削除できる（新規生成だけが止まる）
      const deleted = await jsonBody(await bff.app.request("/api/settings/content/key", { method: "DELETE" }));
      assert.equal(deleted.keyEpoch, 1, "行があった削除でキー世代が進む");
      const list = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image"));
      assert.equal(list.items.length, 1);
      assert.equal(list.keyEpoch, 1);
      assert.equal(list.items[0].keyEpoch, 0, "試行の行は旧キーの世代を保つ");
      const blocked = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(blocked.status, 400);

      const removed = await jsonBody(
        await bff.app.request(`/api/settings/content/trials/${created.trial.id}`, { method: "DELETE" }),
      );
      assert.equal(removed.removed, 1);
    } finally {
      await bff.close();
    }
  });
});

test("BFF の close は実行中の試行を中断し、次の起動で running は interrupted になる", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    const created = await (async () => {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      return jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
        ),
      );
    })();
    await bff.close();
    assert.equal(images.pending[0]?.aborted(), true, "close で provider の呼び出しを abort する");

    const reopened = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      const list = await jsonBody(await reopened.app.request("/api/settings/content/trials?kind=image"));
      const row = list.items.find((item: any) => item.id === created.trial.id);
      assert.equal(row?.state, "interrupted");
    } finally {
      await reopened.close();
    }
  });
});
