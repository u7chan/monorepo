// 試行ジョブの API（開始 / 取得 / 一覧 / キャンセル / 削除）。実 API は呼ばず stub pi とアプリ DB で検証する。
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SECRET_MASTER_KEY_ENV } from "../src/secret-crypto";
import { TEST_MASTER_KEY } from "./app-secret-fixture";
import { createBffApp } from "../src/app";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import {
  CONTENT_TRIAL_BGM_MODEL_MESSAGE,
  CONTENT_TRIAL_BGM_PROMPT_TOO_LONG_MESSAGE,
  CONTENT_TRIAL_DELETE_RUNNING_MESSAGE,
  CONTENT_TRIAL_DISK_SHORT_CODE,
  CONTENT_TRIAL_DISK_SHORT_MESSAGE,
  CONTENT_TRIAL_IMAGE_MODEL_MESSAGE,
  CONTENT_TRIAL_NOT_FOUND_MESSAGE,
  CONTENT_TRIAL_SPEECH_MODEL_MESSAGE,
} from "../src/content-trials";
import { TRIAL_ARTIFACT_USAGE_WARNING_BYTES } from "../src/content-trial-artifacts";
import { BGM_MODEL, BGM_PROMPT_MAX_LENGTH } from "../src/bgm";
import { DEFAULT_IMAGE_MODEL } from "../src/content-settings";
import { DEFAULT_SPEECH_MODEL } from "../src/speech-catalog";
import { IMAGE_PROVIDER_ID, type ImageGenerationInput, type ImageGenerationResult } from "../src/images";
import { asPiBff, createStubPi } from "./stub-pi";

// アプリ DB の APIキーは暗号化して保存する。このファイルの BFF には master key を立てて起動する
process.env[SECRET_MASTER_KEY_ENV] = TEST_MASTER_KEY;

const KEY = "sk-image-dummy-key-0123456789abcdef";
const MODEL = `${IMAGE_PROVIDER_ID}/${DEFAULT_IMAGE_MODEL}`;
const CATALOG_MODEL = "black-forest-labs/flux.2-max";

/** 実バイトが PNG として読める最小の画像（保存側は先頭ヘッダを見る） */
function pngImage(width = 8, height = 6): { mimeType: string; data: string } {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") };
}

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

/** 試行が終端になるまで GET で待つ（成果物の書き込みは非同期なので、固定の待ちにしない） */
async function waitForState(
  bff: { app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> } },
  id: string,
  state: string,
): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = await jsonBody(await bff.app.request(`/api/settings/content/trials/${id}`));
    if (body.trial?.state === state) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`trial ${id} did not reach ${state}`);
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
      const sent = images.pending[0]?.input;
      assert.equal(sent?.provider, "openrouter");
      assert.equal(sent?.provider === "openrouter" ? sent.apiKey : undefined, KEY, "生成器へはキーを渡す");

      // 遅れて届いた結果は捨て、状態を戻さない
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
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
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, created.trial.id, "succeeded");

      const list = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image"));
      assert.equal(list.items[0]?.state, "succeeded");
      assert.equal(list.items[0]?.failureCode, null);
      assert.equal(typeof list.items[0]?.durationMs, "number");
      assert.equal(list.items[0]?.id, created.trial.id);
      assert.equal(list.items[0]?.artifactState, "stored");
      assert.equal(list.items[0]?.charged, true);
      assert.deepEqual(list.items[0]?.artifact, { format: "png", bytes: 33, width: 8, height: 6 });
      // 保存容量は保存済みの成功だけを DB のバイト数で合計する
      assert.deepEqual(list.artifactUsage, { count: 1, bytes: 33 });
      // 容量警告は server のしきい値と判定だけを載せ、画面に値を推測させない
      assert.deepEqual(list.artifactWarning, {
        thresholdBytes: TRIAL_ARTIFACT_USAGE_WARNING_BYTES,
        warning: false,
      });
      // 実体は会話ストアの兄弟 `<dir>/trials` に置く（プロジェクトでも generated/ でもない）
      assert.deepEqual(await readdir(join(dir, "trials")), [`${created.trial.id}.png`]);

      const removed = await jsonBody(await bff.app.request("/api/settings/content/trials", { method: "DELETE" }));
      assert.equal(removed.removed, 1);
      const empty = await jsonBody(await bff.app.request("/api/settings/content/trials"));
      assert.deepEqual(empty.items, []);
      assert.deepEqual(empty.artifactUsage, { count: 0, bytes: 0 });
      assert.equal(empty.artifactWarning.warning, false, "消した後の容量で判定し直す");
      // 削除で成果物も消える
      assert.deepEqual(await readdir(join(dir, "trials")), []);
    } finally {
      await bff.close();
    }
  });
});

test("置き場の空きが足りないときは、行を作らずに 503 のコード付きで止める", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: null,
      trialStatfs: async () => ({ bsize: 1, bavail: 0 }),
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const refused = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(refused.status, 503);
      const body = await jsonBody(refused);
      assert.equal(body.code, CONTENT_TRIAL_DISK_SHORT_CODE, "保存の失敗（storage）とは別のコードで返す");
      assert.equal(body.error, CONTENT_TRIAL_DISK_SHORT_MESSAGE);
      // 開始していないので履歴に残らず、provider も呼ばない
      const list = await jsonBody(await bff.app.request("/api/settings/content/trials"));
      assert.deepEqual(list.items, []);
      assert.equal(images.pending.length, 0);
    } finally {
      await bff.close();
    }
  });
});

test("空きを測れない環境では開始を止めない", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: null,
      // 非対応の fs など、空きを読めない環境
      trialStatfs: async () => {
        throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
      },
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const started = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(started.status, 202);
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
    } finally {
      await bff.close();
    }
  });
});

test("空きが足りなくても保存済みの同じ入力は再利用し、別のテイクは止める", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    let bavail = 1_000_000_000_000;
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(pi),
      workspace: null,
      trialStatfs: async () => ({ bsize: 1, bavail }),
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const created = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
        ),
      );
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, created.trial.id, "succeeded");

      bavail = 0;
      const reused = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(reused.status, 200, "provider を呼ばない再利用は空きが無くても返せる");
      const reusedBody = await jsonBody(reused);
      assert.equal(reusedBody.reused, true);
      assert.equal(reusedBody.trial.id, created.trial.id);
      assert.equal(images.pending.length, 1, "再利用で生成器を呼ばない");

      const forced = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat", force: true }),
      );
      assert.equal(forced.status, 503, "別のテイクは新しい保存が要る");
      assert.equal((await jsonBody(forced)).code, CONTENT_TRIAL_DISK_SHORT_CODE);
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
      assert.match((await jsonBody(outside)).error, new RegExp(CONTENT_TRIAL_IMAGE_MODEL_MESSAGE));

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
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, created.trial.id, "succeeded");

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

test("raw 配信は trial id だけで引き、保存時の MIME と nosniff / no-store を返す", async () => {
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
      const id = created.trial.id as string;
      // 実行中は成果物が無い
      assert.equal((await bff.app.request(`/api/settings/content/trials/${id}/raw`)).status, 404);

      images.pending[0]?.resolve({ ok: true, image: pngImage(640, 480) });
      await waitForState(bff, id, "succeeded");

      const raw = await bff.app.request(`/api/settings/content/trials/${id}/raw`);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers.get("content-type"), "image/png");
      assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
      assert.equal(raw.headers.get("cache-control"), "no-store");
      assert.equal(raw.headers.get("content-disposition"), null, "通常表示はインライン");
      assert.equal((await raw.arrayBuffer()).byteLength, 33);

      const download = await bff.app.request(`/api/settings/content/trials/${id}/raw?download=1`);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-disposition"), `attachment; filename="${id}.png"`);

      // 未知の id・id にパスや拡張子を混ぜた要求は配信しない
      for (const requested of [
        "trial-ffffffffffffffffffffffff",
        `${id}.png`,
        "..%2F..%2Fetc%2Fpasswd",
        "%2Fetc%2Fpasswd",
        "trial-1",
      ]) {
        const response = await bff.app.request(`/api/settings/content/trials/${requested}/raw`);
        assert.equal(response.status, 404, requested);
      }

      // 失敗した行（保存できなかった成功）も配信しない
      const failed = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a dog" }),
        ),
      );
      images.pending[1]?.resolve({ ok: false, code: "rate_limited", message: "混雑" });
      await waitForState(bff, failed.trial.id, "failed");
      assert.equal((await bff.app.request(`/api/settings/content/trials/${failed.trial.id}/raw`)).status, 404);
    } finally {
      await bff.close();
    }
  });
});

test("同じ入力の成功は再課金せず 200 で返し、応答の形を変えない", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const first = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(first.status, 202);
      const created = await jsonBody(first);
      assert.equal(created.reused, false);
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, created.trial.id, "succeeded");

      const reused = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(reused.status, 200);
      const body = await jsonBody(reused);
      assert.equal(body.reused, true);
      assert.equal(body.trial.id, created.trial.id);
      assert.equal(body.trial.artifactState, "stored");
      // provider は 1 回だけ呼ばれ、履歴も増えない
      assert.equal(images.pending.length, 1);
      const list = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image"));
      assert.equal(list.items.length, 1);
    } finally {
      await bff.close();
    }
  });
});

test("force / 現在のキー世代 / 成果物欠損は再利用せず、新しい試行を開始する", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const first = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(first.status, 202);
      const created = await jsonBody(first);
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, created.trial.id, "succeeded");

      // force は同じプロンプトでも保存済み結果を無視する
      const forced = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat", force: true }),
      );
      assert.equal(forced.status, 202);
      const forcedBody = await jsonBody(forced);
      assert.equal(forcedBody.reused, false);
      assert.notEqual(forcedBody.trial.id, created.trial.id);
      assert.equal(images.pending.length, 2);
      images.pending[1]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, forcedBody.trial.id, "succeeded");

      // キーを変えると世代が変わり、同じ入力でも前の世代は再利用しない
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: "sk-image-dummy-key-other-0123456789" }));
      const afterKey = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(afterKey.status, 202);
      const afterKeyBody = await jsonBody(afterKey);
      assert.equal(afterKeyBody.reused, false);
      assert.equal(afterKeyBody.trial.keyEpoch, 1);
      assert.equal(images.pending.length, 3);
      images.pending[2]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, afterKeyBody.trial.id, "succeeded");

      // 成果物ファイルが消えている成功は再利用しない
      await rm(join(dir, "trials", `${afterKeyBody.trial.id}.png`));
      const missing = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
      );
      assert.equal(missing.status, 202);
      const missingBody = await jsonBody(missing);
      assert.equal(missingBody.reused, false);
      assert.notEqual(missingBody.trial.id, afterKeyBody.trial.id);
      assert.equal(images.pending.length, 4);
    } finally {
      await bff.close();
    }
  });
});

test("音声の試行は試行 API に載り、raw は音声の MIME で返し、同じ入力は再課金しない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi({
      onGenerateSpeech: async () => ({
        ok: true,
        speech: { audio: new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer, format: "mp3", contentType: "audio/mpeg" },
      }),
    });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const body = { kind: "speech", model: DEFAULT_SPEECH_MODEL, prompt: "こんにちは", voice: "Aoede", speed: 1.1 };
      const started = await bff.app.request("/api/settings/content/trials", jsonPost(body));
      assert.equal(started.status, 202);
      const created = await jsonBody(started);
      assert.equal(created.trial.kind, "speech");
      assert.equal(created.trial.voice, "Aoede");
      assert.equal(created.trial.speed, 1.1);
      assert.equal(created.trial.instructions, null);
      await waitForState(bff, created.trial.id, "succeeded");

      // 実体は画像と同じ置き場に `<trialId>.mp3` で置く
      assert.deepEqual(await readdir(join(dir, "trials")), [`${created.trial.id}.mp3`]);

      const raw = await bff.app.request(`/api/settings/content/trials/${created.trial.id}/raw`);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers.get("content-type"), "audio/mpeg");
      assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
      assert.equal(raw.headers.get("cache-control"), "no-store");
      const download = await bff.app.request(`/api/settings/content/trials/${created.trial.id}/raw?download=1`);
      assert.equal(download.headers.get("content-disposition"), `attachment; filename="${created.trial.id}.mp3"`);

      const list = await jsonBody(await bff.app.request("/api/settings/content/trials"));
      assert.deepEqual(list.artifactUsage, { count: 1, bytes: 4 }, "画像と同じ保存容量に載る");

      // 同じ入力（本文 + モデル + ボイス + 話速）は provider を呼ばずに 200 で返す
      const reused = await bff.app.request("/api/settings/content/trials", jsonPost(body));
      assert.equal(reused.status, 200);
      const reusedBody = await jsonBody(reused);
      assert.equal(reusedBody.reused, true);
      assert.equal(reusedBody.trial.id, created.trial.id);
      assert.equal(pi.speechCalls.length, 1);

      // 話速が違えば新しい試行として課金対象になる
      const next = await bff.app.request("/api/settings/content/trials", jsonPost({ ...body, speed: 1.2 }));
      assert.equal(next.status, 202);
      assert.equal(pi.speechCalls.length, 2);
      await waitForState(bff, (await jsonBody(next)).trial.id, "succeeded");
    } finally {
      await bff.close();
    }
  });
});

test("お試し再生のルートは退役し、音声の生成は試行 API だけが持つ", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi()),
      workspace: null,
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const legacy = await bff.app.request(
        "/api/settings/content/speech/preview",
        jsonPost({ model: DEFAULT_SPEECH_MODEL, voice: "Aoede", text: "こんにちは" }),
      );
      assert.equal(legacy.status, 404, "退役したルートは存在しない（別の課金経路を残さない）");
    } finally {
      await bff.close();
    }
  });
});

test("raw 配信は単一 Range を解釈し、206 / 416 / 解釈できない Range の 200 を返す（画像）", async () => {
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
      images.pending[0]?.resolve({ ok: true, image: pngImage(640, 480) });
      await waitForState(bff, created.trial.id, "succeeded");
      const url = `/api/settings/content/trials/${created.trial.id}/raw`;

      // 200 は全体に加えて Range を受けることを宣言する
      const full = await bff.app.request(url);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("accept-ranges"), "bytes");
      assert.equal(full.headers.get("content-length"), "33");
      assert.equal((await full.arrayBuffer()).byteLength, 33);

      // 開始 / 末尾 / サフィックスの 3 形を 206 で満たす
      for (const [range, start, end] of [
        ["bytes=0-9", 0, 9],
        ["bytes=10-", 10, 32],
        ["bytes=-5", 28, 32],
      ] as const) {
        const partial = await bff.app.request(url, { headers: { Range: range } });
        assert.equal(partial.status, 206, range);
        assert.equal(partial.headers.get("content-range"), `bytes ${start}-${end}/33`, range);
        assert.equal(partial.headers.get("content-length"), String(end - start + 1), range);
        assert.equal(partial.headers.get("accept-ranges"), "bytes", range);
        assert.equal(partial.headers.get("x-content-type-options"), "nosniff", range);
        assert.equal(partial.headers.get("cache-control"), "no-store", range);
        assert.equal((await partial.arrayBuffer()).byteLength, end - start + 1, range);
      }

      // 満たせない範囲だけ 416。Content-Range は全体の長さを表す
      for (const range of ["bytes=33-", "bytes=-0"]) {
        const unsatisfiable = await bff.app.request(url, { headers: { Range: range } });
        assert.equal(unsatisfiable.status, 416, range);
        assert.equal(unsatisfiable.headers.get("content-range"), "bytes */33", range);
      }

      // 構文不正・複数レンジ・bytes 以外の単位は Range を無視して 200（RFC 9110）
      for (const range of ["bytes=abc", "bytes=9-2", "bytes=0-1,3-4", "items=0-1"]) {
        const ignored = await bff.app.request(url, { headers: { Range: range } });
        assert.equal(ignored.status, 200, range);
        assert.equal((await ignored.arrayBuffer()).byteLength, 33, range);
      }

      // ダウンロードでも同じ Range 契約と添付ヘッダを両立させる
      const download = await bff.app.request(`${url}?download=1`, { headers: { Range: "bytes=0-9" } });
      assert.equal(download.status, 206);
      assert.equal(download.headers.get("content-disposition"), `attachment; filename="${created.trial.id}.png"`);
    } finally {
      await bff.close();
    }
  });
});

test("raw 配信の Range は音声でも同じ契約になる（206 と 416）", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi({
      onGenerateSpeech: async () => ({
        ok: true,
        speech: { audio: new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer, format: "mp3", contentType: "audio/mpeg" },
      }),
    });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const created = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "speech", model: DEFAULT_SPEECH_MODEL, prompt: "こんにちは" }),
        ),
      );
      await waitForState(bff, created.trial.id, "succeeded");
      const url = `/api/settings/content/trials/${created.trial.id}/raw`;

      const partial = await bff.app.request(url, { headers: { Range: "bytes=0-1" } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get("content-type"), "audio/mpeg");
      assert.equal(partial.headers.get("content-range"), "bytes 0-1/4");
      assert.equal((await partial.arrayBuffer()).byteLength, 2);

      const unsatisfiable = await bff.app.request(url, { headers: { Range: "bytes=4-" } });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(unsatisfiable.headers.get("content-range"), "bytes */4");
      // 本文は JSON のエラーなので、成果物の MIME ではなく application/json を宣言する
      assert.equal(unsatisfiable.headers.get("content-type"), "application/json");
      assert.equal(typeof (await jsonBody(unsatisfiable)).error, "string");
    } finally {
      await bff.close();
    }
  });
});

test("全削除と個別削除・キャンセルは種別をまたがない", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const speech: { input: unknown; resolve: (value: any) => void; aborted: () => boolean }[] = [];
    const pi = createStubPi({
      onGenerateImage: images.onGenerateImage,
      onGenerateSpeech: (input) =>
        new Promise((resolve) => speech.push({ input, resolve, aborted: () => input.signal?.aborted === true })),
    });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const image = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a cat" }),
        ),
      );
      images.pending[0]?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, image.trial.id, "succeeded");

      // 種別を渡した全削除は、その種別の履歴だけを消す
      const speechOne = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "speech", model: DEFAULT_SPEECH_MODEL, prompt: "ひとつめ" }),
        ),
      );
      speech[0]?.resolve({
        ok: true,
        speech: { audio: new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer, format: "mp3", contentType: "audio/mpeg" },
      });
      await waitForState(bff, speechOne.trial.id, "succeeded");

      const removed = await jsonBody(
        await bff.app.request("/api/settings/content/trials?kind=speech", { method: "DELETE" }),
      );
      assert.equal(removed.removed, 1, "音声の試行だけを消す");
      const afterAll = await jsonBody(await bff.app.request("/api/settings/content/trials"));
      assert.deepEqual(
        afterAll.items.map((item: { id: string }) => item.id),
        [image.trial.id],
        "画像の履歴と成果物は残す",
      );
      assert.deepEqual(afterAll.artifactUsage, { count: 1, bytes: 33 }, "画像の容量も残す");
      assert.deepEqual(await readdir(join(dir, "trials")), [`${image.trial.id}.png`], "音声の成果物だけを消す");

      // 個別削除もキャンセルも id でしか効かない（もう一方の種別の実行中は止めない）
      const runningImage = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "a dog" }),
        ),
      );
      const runningSpeech = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "speech", model: DEFAULT_SPEECH_MODEL, prompt: "ふたつめ" }),
        ),
      );
      const canceled = await bff.app.request(`/api/settings/content/trials/${runningImage.trial.id}/cancel`, {
        method: "POST",
      });
      assert.equal(canceled.status, 200);
      const speechStill = await jsonBody(
        await bff.app.request(`/api/settings/content/trials/${runningSpeech.trial.id}`),
      );
      assert.equal(speechStill.trial.state, "running", "画像のキャンセルで音声を止めない");
      speech[1]?.resolve({
        ok: true,
        speech: { audio: new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer, format: "mp3", contentType: "audio/mpeg" },
      });
      await waitForState(bff, runningSpeech.trial.id, "succeeded");

      const deleted = await bff.app.request(`/api/settings/content/trials/${runningImage.trial.id}`, {
        method: "DELETE",
      });
      assert.equal(deleted.status, 200);
      const remaining = await jsonBody(await bff.app.request("/api/settings/content/trials"));
      assert.deepEqual(
        remaining.items.map((item: { id: string }) => item.id).sort(),
        [image.trial.id, runningSpeech.trial.id].sort(),
        "個別削除は指定した id だけを消す",
      );
    } finally {
      await bff.close();
    }
  });
});

test("BGM の試行は試行 API に載り、raw は audio/mpeg で返し、同じプロンプトは再課金しない", async () => {
  await withStoreDir(async (dir) => {
    const pi = createStubPi({});
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const tooLong = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "bgm", model: BGM_MODEL, prompt: "a".repeat(BGM_PROMPT_MAX_LENGTH + 1) }),
      );
      assert.equal(tooLong.status, 400);
      assert.equal((await jsonBody(tooLong)).error, CONTENT_TRIAL_BGM_PROMPT_TOO_LONG_MESSAGE);
      assert.equal(pi.bgmCalls.length, 0);
      const started = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "bgm", model: BGM_MODEL, prompt: "静かな夜のピアノ" }),
      );
      assert.equal(started.status, 202);
      const created = await jsonBody(started);
      assert.equal(created.trial.kind, "bgm");
      assert.equal(created.trial.model, BGM_MODEL);
      assert.equal(created.trial.voice, null);
      await waitForState(bff, created.trial.id, "succeeded");
      assert.equal(pi.bgmCalls.length, 1);
      assert.equal(pi.bgmCalls[0]?.prompt, "静かな夜のピアノ");

      // 実体は画像・音声と同じ置き場に `<trialId>.mp3` で置く
      assert.deepEqual(await readdir(join(dir, "trials")), [`${created.trial.id}.mp3`]);
      const raw = await bff.app.request(`/api/settings/content/trials/${created.trial.id}/raw`);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers.get("content-type"), "audio/mpeg");
      assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
      assert.equal(raw.headers.get("cache-control"), "no-store");
      const download = await bff.app.request(`/api/settings/content/trials/${created.trial.id}/raw?download=1`);
      assert.equal(download.headers.get("content-disposition"), `attachment; filename="${created.trial.id}.mp3"`);

      // 保存容量は種別をまたいだ合計で、一覧は `?kind=bgm` で絞れる
      const bgm = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=bgm"));
      assert.equal(bgm.items.length, 1);
      assert.deepEqual(bgm.artifactUsage, { count: 1, bytes: 6 });
      assert.deepEqual((await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image"))).items, []);

      // 同じプロンプト + モデルは provider を呼ばずに 200 で返す
      const reused = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "bgm", model: BGM_MODEL, prompt: "静かな夜のピアノ" }),
      );
      assert.equal(reused.status, 200);
      assert.equal((await jsonBody(reused)).reused, true);
      assert.equal(pi.bgmCalls.length, 1);

      // プロンプトが違えば新しい試行として生成する
      const next = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "bgm", model: BGM_MODEL, prompt: "昼の市場" }),
        ),
      );
      await waitForState(bff, next.trial.id, "succeeded");
      assert.equal(pi.bgmCalls.length, 2);

      // 全削除は種別を絞り、BGM の成果物も消える
      const removed = await jsonBody(
        await bff.app.request("/api/settings/content/trials?kind=bgm", { method: "DELETE" }),
      );
      assert.equal(removed.removed, 2);
      assert.deepEqual(await readdir(join(dir, "trials")), []);
    } finally {
      await bff.close();
    }
  });
});

test("モデルを受け付けない 400 の文言は種別ごとに変え、画像の文言を他の種別へ出さない", async () => {
  await withStoreDir(async (dir) => {
    const bff = await openBff({
      cwd: "/tmp/project",
      sessionStoreDir: dir,
      pi: asPiBff(createStubPi({})),
      workspace: null,
    });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const image = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "image", model: "openrouter/nope/model", prompt: "a cat" }),
      );
      assert.match((await jsonBody(image)).error, new RegExp(CONTENT_TRIAL_IMAGE_MODEL_MESSAGE));

      const speech = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "speech", model: "nope/model", prompt: "こんにちは" }),
      );
      assert.equal(speech.status, 400);
      const speechError = (await jsonBody(speech)).error as string;
      assert.ok(speechError.startsWith(CONTENT_TRIAL_SPEECH_MODEL_MESSAGE));
      assert.equal(speechError.includes("画像"), false, "音声の試行に画像の文言を出さない");

      const bgm = await bff.app.request(
        "/api/settings/content/trials",
        jsonPost({ kind: "bgm", model: "openrouter/nope/model", prompt: "静かな夜" }),
      );
      assert.equal(bgm.status, 400);
      const bgmError = (await jsonBody(bgm)).error as string;
      assert.ok(bgmError.startsWith(CONTENT_TRIAL_BGM_MODEL_MESSAGE));
      assert.equal(bgmError.includes("画像"), false, "BGM の試行に画像の文言を出さない");
    } finally {
      await bff.close();
    }
  });
});

test("一覧は limit / before でページを返し、state=running は実行中の行だけを返す", async () => {
  await withStoreDir(async (dir) => {
    const images = createImageHarness();
    const pi = createStubPi({ onGenerateImage: images.onGenerateImage });
    const bff = await openBff({ cwd: "/tmp/project", sessionStoreDir: dir, pi: asPiBff(pi), workspace: null });
    try {
      await bff.app.request("/api/settings/content/key", jsonPut({ apiKey: KEY }));
      const ids: string[] = [];
      for (const prompt of ["one", "two", "three"]) {
        const created = await jsonBody(
          await bff.app.request("/api/settings/content/trials", jsonPost({ kind: "image", model: MODEL, prompt })),
        );
        ids.push(created.trial.id);
        images.pending.at(-1)?.resolve({ ok: true, image: pngImage() });
        await waitForState(bff, created.trial.id, "succeeded");
      }

      // 一覧は要約（本文の全文は載らず、抜粋だけ）で、`nextBefore` で次のページを取れる
      const first = await jsonBody(await bff.app.request("/api/settings/content/trials?kind=image&limit=2"));
      assert.equal(first.items.length, 2);
      assert.equal(first.hasMore, true);
      assert.equal(typeof first.nextBefore, "string");
      assert.equal(typeof first.items[0].promptPreview, "string");
      assert.equal("prompt" in first.items[0], false, "一覧に本文を載せない");
      assert.equal("instructions" in first.items[0], false, "一覧に演技指示を載せない");

      const second = await jsonBody(
        await bff.app.request(`/api/settings/content/trials?kind=image&limit=2&before=${first.nextBefore}`),
      );
      assert.equal(second.items.length, 1);
      assert.equal(second.hasMore, false);
      assert.equal(second.nextBefore, null);
      assert.deepEqual(
        new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)),
        new Set(ids),
        "2 ページで全件をちょうど 1 回ずつ返す",
      );

      // 実行中の行だけを返す（1 件だけ開始して取得する）
      const started = await jsonBody(
        await bff.app.request(
          "/api/settings/content/trials",
          jsonPost({ kind: "image", model: MODEL, prompt: "running one" }),
        ),
      );
      const running = await jsonBody(await bff.app.request("/api/settings/content/trials?state=running"));
      assert.deepEqual(
        running.items.map((item: { id: string }) => item.id),
        [started.trial.id],
      );
      assert.equal(running.hasMore, false);
      images.pending.at(-1)?.resolve({ ok: true, image: pngImage() });
      await waitForState(bff, started.trial.id, "succeeded");

      // 不正な limit / before / state は 400（クライアントのページ飛びを作らない）
      for (const query of ["limit=0", "limit=101", "limit=abc", "before=abc", "before=1:2:3", "state=succeeded"]) {
        const response = await bff.app.request(`/api/settings/content/trials?${query}`);
        assert.equal(response.status, 400, query);
      }
    } finally {
      await bff.close();
    }
  });
});
