// コンテンツ生成の試行ジョブ（状態遷移・キャンセル・再照合・成果物の保存と削除）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentTrialArtifactRow, ContentTrialRow } from "../src/app-db";
import {
  CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE,
  CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE,
  CONTENT_TRIAL_ARTIFACT_FORMAT_MESSAGE,
  CONTENT_TRIAL_ARTIFACT_MISSING_MESSAGE,
  CONTENT_TRIAL_DELETE_RUNNING_MESSAGE,
  CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE,
  CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE,
  CONTENT_TRIAL_NOT_FOUND_MESSAGE,
  CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE,
  CONTENT_TRIAL_PROMPT_MAX_LENGTH,
  CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE,
  CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE,
  CONTENT_TRIAL_STORAGE_FAILED_MESSAGE,
  CONTENT_TRIAL_UNCONFIGURED_MESSAGE,
  ContentTrialsService,
  type ContentTrialSource,
  type ContentTrialsDb,
} from "../src/content-trials";
import {
  TRIAL_ARTIFACT_MAX_BYTES,
  trialArtifactFileName,
  type TrialArtifactStore,
} from "../src/content-trial-artifacts";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import { IMAGE_GENERATION_TIMEOUT_MS, type ImageGenerationInput, type ImageGenerationResult } from "../src/images";

const KEY = "sk-trial-dummy-key-0123456789abcdef";
const MODEL = "openrouter/openai/gpt-image-2";

/** 実在しうる trial id（`trial-` + 24 hex）。保存名の検査を通すために使う */
function trialId(n: number): string {
  return `trial-${String(n).padStart(24, "0")}`;
}

/** 実バイトが PNG として読める最小の画像（保存側は先頭ヘッダを見る） */
function pngImage(width = 2, height = 3): { mimeType: string; data: string } {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") };
}

/** 試行の DB。`finishContentTrial` は SQL と同じく `running` の行だけを更新する */
class FakeTrialsDb implements ContentTrialsDb {
  rows = new Map<string, ContentTrialRow>();
  epoch = 0;
  failSave = false;
  failFinish = false;
  failList = false;
  finishCalls = 0;

  readContentKeyEpoch(): number {
    return this.epoch;
  }

  saveContentTrial(row: ContentTrialRow): void {
    if (this.failSave) throw new Error("db save boom");
    this.rows.set(row.id, { ...row });
  }

  finishContentTrial(input: {
    id: string;
    state: string;
    failureCode: string | null;
    failureMessage: string | null;
    finishedAt: number;
    durationMs: number | null;
    charged: boolean;
    artifact: ContentTrialArtifactRow | null;
  }): boolean {
    this.finishCalls += 1;
    if (this.failFinish) throw new Error("db finish boom");
    const row = this.rows.get(input.id);
    if (!row || row.state !== "running") return false;
    this.rows.set(input.id, {
      ...row,
      state: input.state,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      charged: input.charged,
      artifactState: input.artifact ? "stored" : "none",
      artifact: input.artifact,
    });
    return true;
  }

  readContentTrial(id: string): ContentTrialRow | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  listContentTrials(kind?: string): ContentTrialRow[] {
    if (this.failList) throw new Error("db list boom");
    return [...this.rows.values()]
      .filter((row) => kind === undefined || row.kind === kind)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((row) => ({ ...row }));
  }

  findReusableContentTrial(input: { kind: string; model: string; prompt: string }): ContentTrialRow | undefined {
    const row = this.listContentTrials()
      .filter(
        (candidate) =>
          candidate.kind === input.kind &&
          candidate.model === input.model &&
          candidate.prompt === input.prompt &&
          candidate.state === "succeeded" &&
          candidate.artifactState === "stored" &&
          candidate.artifact !== null,
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return row ? { ...row } : undefined;
  }

  readContentTrialArtifactUsage(): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const row of this.rows.values()) {
      if (row.state !== "succeeded" || row.artifactState !== "stored" || !row.artifact) continue;
      count += 1;
      bytes += row.artifact.bytes;
    }
    return { count, bytes };
  }

  deleteContentTrial(id: string): boolean {
    return this.rows.delete(id);
  }

  deleteTerminalContentTrials(kind?: string): number {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.state === "running") continue;
      if (kind !== undefined && row.kind !== kind) continue;
      this.rows.delete(id);
      removed += 1;
    }
    return removed;
  }

  interruptRunningContentTrials(now: number): number {
    let changed = 0;
    for (const [id, row] of this.rows) {
      if (row.state !== "running") continue;
      this.rows.set(id, { ...row, state: "interrupted", finishedAt: now });
      changed += 1;
    }
    return changed;
  }
}

/** 成果物の置き場。`hold` で write を、`holdList` で list を止め、競合の窓を作れるようにする */
class FakeArtifactStore implements TrialArtifactStore {
  files = new Map<string, Uint8Array>();
  failWrite = false;
  failRemove = false;
  /** write の途中で止める（保存後・終端更新前の窓を作る） */
  hold: { promise: Promise<void>; release: () => void } | null = null;
  /** list の途中で止める（一覧の取得中にジョブが確定する窓を作る）。返す一覧は呼ばれた時点のもの */
  holdList: { promise: Promise<void>; release: () => void } | null = null;
  listCalls = 0;

  async write(input: { trialId: string; format: "png" | "jpeg" | "webp"; bytes: Uint8Array }): Promise<void> {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(trialArtifactFileName(input.trialId, input.format), input.bytes);
    if (this.hold) await this.hold.promise;
  }

  async read(fileName: string): Promise<ArrayBuffer | undefined> {
    const bytes = this.files.get(fileName);
    if (!bytes) return undefined;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async remove(fileName: string): Promise<void> {
    if (this.failRemove) throw new Error("remove boom");
    this.files.delete(fileName);
  }

  async list(): Promise<string[]> {
    this.listCalls += 1;
    const snapshot = [...this.files.keys()];
    if (this.holdList) await this.holdList.promise;
    return snapshot;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 生成器の呼び出しを 1 件ずつ制御できるようにする。`signal` は abort で観測できる */
interface Generation {
  input: ImageGenerationInput;
  resolve: (result: ImageGenerationResult) => void;
  aborted: () => boolean;
}

function row(overrides: Partial<ContentTrialRow> & { id: string }): ContentTrialRow {
  const { id, ...rest } = overrides;
  return {
    id,
    kind: "image",
    model: MODEL,
    prompt: "old",
    state: "running",
    keyEpoch: 0,
    artifactState: "none",
    charged: false,
    artifact: null,
    failureCode: null,
    failureMessage: null,
    startedAt: 1,
    finishedAt: null,
    durationMs: null,
    ...rest,
  };
}

function createHarness(
  options: {
    row?: { imageModel: string; enabled: boolean } | undefined;
    apiKey?: string | null;
    models?: readonly string[];
    generate?: boolean;
    artifacts?: boolean;
  } = {},
) {
  const db = new FakeTrialsDb();
  const store = new FakeArtifactStore();
  const generations: Generation[] = [];
  let now = 1_000;
  const source: ContentTrialSource = {
    read: () => ({
      row: "row" in options ? options.row : { imageModel: "openai/gpt-image-2", enabled: true },
      apiKey: "apiKey" in options ? (options.apiKey ?? null) : KEY,
    }),
    models: () => options.models ?? [MODEL],
  };
  const service = new ContentTrialsService({
    db,
    source,
    generateImage:
      options.generate === false
        ? undefined
        : (input) => {
            const pending = deferred<ImageGenerationResult>();
            generations.push({ input, resolve: pending.resolve, aborted: () => input.signal?.aborted === true });
            return pending.promise;
          },
    artifacts: options.artifacts === false ? undefined : store,
    maskError: (text) => text.split(KEY).join("[REDACTED]"),
    now: () => now,
  });
  return {
    db,
    store,
    service,
    generations,
    advanceClock: (ms: number) => {
      now += ms;
    },
    start: (prompt = "a cat", model = MODEL) => service.start({ kind: "image", model, prompt }),
  };
}

/** 非同期のジョブが DB へ書くまで待つ（実時間ではなくマイクロタスクだけを回す） */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

test("開始は 202 の running で、世代と artifactState: none を記録し、APIキーは保存しない", () => {
  const harness = createHarness();
  harness.db.epoch = 3;
  const outcome = harness.start("a cat on a sofa");
  assert.equal(outcome.status, 202);
  if (outcome.status !== 202) return;
  assert.equal(outcome.reused, false);
  assert.equal(outcome.trial.state, "running");
  assert.equal(outcome.trial.kind, "image");
  assert.equal(outcome.trial.model, MODEL);
  assert.equal(outcome.trial.prompt, "a cat on a sofa");
  assert.equal(outcome.trial.keyEpoch, 3);
  assert.equal(outcome.trial.artifactState, "none");
  assert.equal(outcome.trial.artifact, null);
  assert.equal(outcome.trial.charged, false);
  assert.equal(outcome.trial.recorded, true);
  const saved = harness.db.rows.get(outcome.trial.id);
  assert.ok(saved);
  assert.equal(saved.state, "running");
  assert.equal(saved.keyEpoch, 3);
  // APIキーは行のどこにも入らない（プロンプトにも入れない）
  assert.equal(JSON.stringify(saved).includes(KEY), false);
  // 生成器へは provider / model / prompt / key / signal を渡す
  const generation = harness.generations[0];
  assert.ok(generation);
  assert.equal(generation.input.provider, "openrouter");
  assert.equal(generation.input.model, "openai/gpt-image-2");
  assert.equal(generation.input.apiKey, KEY);
});

test("成功は成果物を保存して succeeded にし、寸法・サイズ・形式と課金済みを記録する", async () => {
  const harness = createHarness();
  const first = harness.start();
  assert.equal(first.status, 202);
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage(1024, 768) });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const succeeded = harness.db.rows.get(first.trial.id);
  assert.equal(succeeded?.failureCode, null);
  assert.equal(succeeded?.artifactState, "stored");
  assert.equal(succeeded?.artifact?.format, "png");
  assert.equal(succeeded?.artifact?.width, 1024);
  assert.equal(succeeded?.artifact?.height, 768);
  assert.equal(succeeded?.artifact?.bytes, 33);
  assert.equal(succeeded?.charged, true);
  assert.equal(typeof succeeded?.durationMs, "number");
  // 実体は trial id の保存名で 1 件だけ置かれる
  assert.equal(harness.store.files.size, 1);
  assert.ok(harness.store.files.has(trialArtifactFileName(first.trial.id, "png")));

  // 保存容量は succeeded + stored だけを DB のバイト数で合計する
  const list = harness.service.list("image");
  assert.deepEqual(list.artifactUsage, { count: 1, bytes: 33 });

  const second = harness.start("a dog");
  assert.equal(second.status, 202);
  if (second.status !== 202) return;
  harness.generations[1]?.resolve({ ok: false, code: "invalid_key", message: "画像APIキーが無効です" });
  await until(() => harness.db.rows.get(second.trial.id)?.state === "failed");
  const failed = harness.db.rows.get(second.trial.id);
  assert.equal(failed?.failureCode, "invalid_key");
  assert.equal(failed?.failureMessage, "画像APIキーが無効です");
  assert.equal(failed?.charged, false);

  const third = harness.start("a bird");
  assert.equal(third.status, 202);
  if (third.status !== 202) return;
  harness.generations[2]?.resolve({ ok: false, code: "aborted", message: "画像生成を中断しました" });
  await until(() => harness.db.rows.get(third.trial.id)?.state === "canceled");
  assert.equal(harness.db.rows.get(third.trial.id)?.failureCode, "aborted");
});

test("同じ入力の保存済み成功は provider を呼ばず 200 で返し、新しい成功を記録しない", async () => {
  const harness = createHarness();
  const first = harness.start("a cat on a sofa");
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const rowsBefore = harness.db.rows.size;
  const finishesBefore = harness.db.finishCalls;

  const reused = harness.start("a cat on a sofa");
  assert.equal(reused.status, 200);
  if (reused.status !== 200) return;
  assert.equal(reused.reused, true);
  assert.equal(reused.trial.id, first.trial.id);
  assert.equal(reused.trial.artifactState, "stored");
  // provider も呼ばず、行も増やさない
  assert.equal(harness.generations.length, 1);
  assert.equal(harness.db.rows.size, rowsBefore);
  assert.equal(harness.db.finishCalls, finishesBefore);
  // 保存済みの成果物が無い成功（段階 1 の none）は再利用しない
  harness.db.rows.set("trial-legacy", row({ id: "trial-legacy", prompt: "legacy", state: "succeeded" }));
  const again = harness.start("legacy");
  assert.equal(again.status, 202);
});

test("保存できない形式（svg / html / 不明な MIME）は保存前に拒否し、課金済みの失敗にする", async () => {
  for (const mimeType of ["image/svg+xml", "text/html", "application/octet-stream"]) {
    const harness = createHarness();
    const started = harness.start();
    if (started.status !== 202) return;
    harness.generations[0]?.resolve({
      ok: true,
      image: { mimeType, data: Buffer.from("<svg></svg>").toString("base64") },
    });
    await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
    const failed = harness.db.rows.get(started.trial.id);
    assert.equal(failed?.failureCode, "storage", `${mimeType} は storage で倒す`);
    assert.equal(failed?.failureMessage, CONTENT_TRIAL_ARTIFACT_FORMAT_MESSAGE);
    assert.equal(failed?.charged, true, "生成は成功しているので課金済み");
    assert.equal(failed?.artifactState, "none");
    // 保存前なので 1 バイトも書かない
    assert.equal(harness.store.files.size, 0);
  }
});

test("成果物の保存に失敗したら storage の失敗にし、成功として見せない", async () => {
  const harness = createHarness();
  harness.store.failWrite = true;
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  const failed = harness.db.rows.get(started.trial.id);
  assert.equal(failed?.failureCode, "storage");
  assert.equal(failed?.failureMessage, CONTENT_TRIAL_STORAGE_FAILED_MESSAGE);
  assert.equal(failed?.charged, true);
  assert.equal(failed?.artifactState, "none");
  assert.equal(harness.store.files.size, 0);
});

test("保存先を用意できていない起動では、生成が成功しても storage の失敗にする", async () => {
  const harness = createHarness({ artifacts: false });
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  assert.equal(harness.db.rows.get(started.trial.id)?.failureCode, "storage");
});

test("大きすぎる成果物は保存せず、専用の文言で storage の失敗にする", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  const bytes = new Uint8Array(TRIAL_ARTIFACT_MAX_BYTES + 1);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  harness.generations[0]?.resolve({
    ok: true,
    image: { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
  });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  assert.equal(harness.db.rows.get(started.trial.id)?.failureCode, "storage");
  assert.match(harness.db.rows.get(started.trial.id)?.failureMessage ?? "", /大きすぎて保存できません/);
  assert.equal(harness.store.files.size, 0);
});

test("trial id だけで成果物を配信し、保存していない行・未知の id は 404", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  // 実行中はまだ成果物が無い
  assert.equal((await harness.service.raw(started.trial.id)).status, 404);
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  const raw = await harness.service.raw(started.trial.id);
  assert.equal(raw.status, 200);
  if (raw.status !== 200) return;
  assert.equal(raw.contentType, "image/png");
  assert.equal(raw.fileName, trialArtifactFileName(started.trial.id, "png"));
  assert.equal(raw.bytes.byteLength, 33);

  const missing = await harness.service.raw("trial-ffffffffffffffffffffffff");
  assert.equal(missing.status, 404);
  if (missing.status !== 404) return;
  assert.equal(missing.error, CONTENT_TRIAL_ARTIFACT_MISSING_MESSAGE);
  // パスを渡しても id として扱うだけ（トラバーサルにならない）
  assert.equal((await harness.service.raw("../../etc/passwd")).status, 404);

  // 段階 1 の none 行は成果物を持たない
  harness.db.rows.set("trial-legacy", row({ id: "trial-legacy", state: "succeeded" }));
  assert.equal((await harness.service.raw("trial-legacy")).status, 404);
});

test("保存名が行の id と一致しない行（手編集・旧版）は配信しない", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  const saved = harness.db.rows.get(started.trial.id);
  assert.ok(saved?.artifact);
  harness.db.rows.set(started.trial.id, {
    ...saved,
    artifact: { ...saved.artifact, path: "../escape.png" },
  });
  assert.equal((await harness.service.raw(started.trial.id)).status, 404);
});

test("失敗文言はマスカーを通してから保存する", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: false, code: "unknown", message: `upstream said ${KEY}` });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  const message = harness.db.rows.get(started.trial.id)?.failureMessage ?? "";
  assert.equal(message.includes(KEY), false);
  assert.match(message, /\[REDACTED\]/);
});

test("種別ごとに同時 1 本。実行中は 409 で、provider の呼び出しが終わるまでスロットを解放しない", async () => {
  const harness = createHarness();
  const first = harness.start();
  assert.equal(first.status, 202);
  if (first.status !== 202) return;
  assert.equal(harness.service.running("image"), true);
  const rejected = harness.start("another");
  assert.equal(rejected.status, 409);
  if (rejected.status !== 409) return;
  assert.equal(rejected.error, CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE);

  const canceled = harness.service.cancel(first.trial.id);
  assert.equal(canceled.status, 200);
  // キャンセル直後も provider の呼び出しは続く（スロットは解放しない）
  assert.equal(harness.service.running("image"), true);
  assert.equal(harness.start("another").status, 409);
  assert.equal(harness.generations[0]?.aborted(), true);

  harness.generations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("image") === false);
  assert.equal(harness.start("another").status, 202);
});

test("キャンセルは running のときだけ受け付け、遅れて届いた結果で状態を戻さない", async () => {
  const harness = createHarness();
  const started = harness.start();
  assert.equal(started.status, 202);
  if (started.status !== 202) return;
  const canceled = harness.service.cancel(started.trial.id);
  assert.equal(canceled.status, 200);
  if (canceled.status !== 200) return;
  assert.equal(canceled.trial.state, "canceled");
  assert.equal(canceled.trial.recorded, true);

  // 遅れて成功が届いても canceled のままで、成果物も残さない
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.service.running("image") === false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "canceled");
  assert.equal(harness.store.files.size, 0);
  assert.equal(harness.service.get(started.trial.id).status, 200);

  // 完了後のキャンセルは 409 で、状態を戻さない
  const again = harness.service.cancel(started.trial.id);
  assert.equal(again.status, 409);
  if (again.status !== 409) return;
  assert.equal(again.error, CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "canceled");
});

test("完了直後のキャンセルは 409（すでに終端）", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  const canceled = harness.service.cancel(started.trial.id);
  assert.equal(canceled.status, 409);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "succeeded");
});

test("running の削除は 409 で「先に中断してください」、終端だけ消せる", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  const rejected = await harness.service.remove(started.trial.id);
  assert.equal(rejected.status, 409);
  if (rejected.status !== 409) return;
  assert.equal(rejected.error, CONTENT_TRIAL_DELETE_RUNNING_MESSAGE);

  harness.service.cancel(started.trial.id);
  harness.generations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("image") === false);
  const removed = await harness.service.remove(started.trial.id);
  assert.equal(removed.status, 200);
  if (removed.status !== 200) return;
  assert.equal(removed.removed, 1);
  assert.equal(harness.db.rows.has(started.trial.id), false);
  const missing = await harness.service.remove(started.trial.id);
  assert.equal(missing.status, 404);
  if (missing.status !== 404) return;
  assert.equal(missing.error, CONTENT_TRIAL_NOT_FOUND_MESSAGE);
});

test("個別削除はその試行の成果物も消す", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  assert.equal(harness.store.files.size, 1);
  const removed = await harness.service.remove(started.trial.id);
  assert.equal(removed.status, 200);
  assert.equal(harness.store.files.size, 0);
  assert.deepEqual(harness.service.list("image").artifactUsage, { count: 0, bytes: 0 });
});

test("すべて削除は終端だけを対象にし、実行中は残し、成果物も消す", async () => {
  const harness = createHarness();
  const done = harness.start("done");
  if (done.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(done.trial.id)?.state === "succeeded");
  const started = harness.start();
  if (started.status !== 202) return;
  const outcome = await harness.service.removeAll();
  assert.equal(outcome.status, 200);
  assert.equal(outcome.removed, 1);
  assert.equal(harness.db.rows.has(done.trial.id), false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");
  assert.equal(harness.store.files.size, 0);
});

test("時間ベースの自動削除はせず、古い行と成果物を残す", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  // 半年進めても一覧から消えない（再照合も succeeded は触らない）
  harness.advanceClock(180 * 86_400_000);
  harness.service.list("image");
  await harness.service.reconcileArtifacts();
  assert.equal(harness.db.rows.has(started.trial.id), true);
  assert.equal(harness.store.files.size, 1);
});

test("起動時の再照合は succeeded 以外の行のファイルと孤児を消し、succeeded は残す", async () => {
  const harness = createHarness();
  const ok = trialId(1);
  const run = trialId(2);
  const stop = trialId(3);
  const fail = trialId(4);
  const orphan = trialId(5);
  harness.db.rows.set(
    ok,
    row({
      id: ok,
      state: "succeeded",
      artifactState: "stored",
      artifact: { path: `${ok}.png`, bytes: 1, format: "png", width: 1, height: 1 },
    }),
  );
  harness.db.rows.set(run, row({ id: run, state: "running" }));
  harness.db.rows.set(stop, row({ id: stop, state: "interrupted" }));
  harness.db.rows.set(fail, row({ id: fail, state: "failed", failureCode: "storage" }));
  for (const name of [`${ok}.png`, `${run}.png`, `${stop}.png`, `${fail}.png`, `${orphan}.png`]) {
    harness.store.files.set(name, new Uint8Array([1]));
  }

  await harness.service.applyStored();
  assert.deepEqual([...harness.store.files.keys()], [`${ok}.png`]);
  // 取り残した running は interrupted に倒す（成果物は無い）
  assert.equal(harness.db.rows.get(run)?.state, "interrupted");
});

test("オンラインの再照合は、保存後・終端更新前の実行中ジョブの成果物を消さない", async () => {
  const harness = createHarness();
  const hold = deferred<void>();
  harness.store.hold = { promise: hold.promise, release: () => hold.resolve() };
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  // ファイルは書けたが、write がまだ返っていない（DB はまだ running）
  await until(() => harness.store.files.size === 1);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");
  assert.equal(await harness.service.reconcileArtifacts(), 0, "実行中ジョブのファイルは消さない");
  assert.equal(harness.store.files.size, 1);

  harness.store.hold = null;
  hold.resolve();
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  assert.equal(harness.store.files.size, 1);
});

test("一覧の取得中に確定したジョブの成果物を、オンラインの再照合が消さない", async () => {
  const harness = createHarness();
  const holdWrite = deferred<void>();
  harness.store.hold = { promise: holdWrite.promise, release: () => holdWrite.resolve() };
  const started = harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  // ファイルは書けたが write はまだ返っていない（行は running、ジョブはレジストリに居る）
  await until(() => harness.store.files.size === 1);
  const fileName = trialArtifactFileName(started.trial.id, "png");

  // 再照合は行を読み、ファイル一覧の取得で止まる。この間にジョブが succeeded へ確定して
  // レジストリから外れる（行のスナップショットは running のまま）
  const holdList = deferred<void>();
  harness.store.holdList = { promise: holdList.promise, release: () => holdList.resolve() };
  const reconciling = harness.service.reconcileArtifacts();
  await until(() => harness.store.listCalls === 1);
  harness.store.hold = null;
  holdWrite.resolve();
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  await until(() => harness.service.running("image") === false);
  harness.store.holdList = null;
  holdList.resolve();

  assert.equal(await reconciling, 0, "確定済みの成果物を中途ファイルとして消さない");
  assert.ok(harness.store.files.has(fileName), "保存済みのファイルが残る");
  // 配信・容量・再利用が壊れていないこと（消えていれば raw 404 / 容量 0 / 画像の無い成功になる）
  const raw = await harness.service.raw(started.trial.id);
  assert.equal(raw.status, 200);
  assert.deepEqual(harness.service.list("image").artifactUsage, { count: 1, bytes: 33 });
  const reused = harness.start();
  assert.equal(reused.status, 200);
  if (reused.status !== 200) return;
  assert.equal(reused.reused, true);
  assert.equal(reused.trial.id, started.trial.id);
  assert.equal(harness.generations.length, 1, "再利用では provider を呼ばない");
});

test("running のまま残った行は一覧の再照合で interrupted になり、容量に計上されない", async () => {
  const harness = createHarness();
  const startedAt = 1_000 - IMAGE_GENERATION_TIMEOUT_MS * 2;
  const stale = trialId(9);
  harness.db.rows.set(stale, row({ id: stale, startedAt }));
  harness.store.files.set(`${stale}.png`, new Uint8Array([1]));
  const list = harness.service.list("image");
  assert.equal(harness.db.rows.get(stale)?.state, "interrupted");
  assert.deepEqual(list.artifactUsage, { count: 0, bytes: 0 });
  // 一覧は同期的に返るため、置き場の掃除は待たずに走る
  await harness.service.reconcileArtifacts();
  assert.equal(harness.store.files.size, 0);
});

test("終端の記録に失敗したら成果物を消し、メモリの失敗（storage）を返して、回復後に再試行する", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.db.failFinish = true;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.service.running("image") === false);

  const view = harness.service.get(started.trial.id);
  assert.equal(view.status, 200);
  if (view.status !== 200) return;
  assert.equal(view.trial.state, "failed");
  assert.equal(view.trial.failureCode, "storage");
  assert.equal(view.trial.charged, true);
  assert.equal(view.trial.artifactState, "none");
  assert.equal(view.trial.recorded, false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");
  // 行とファイルの片側だけを残さない
  assert.equal(harness.store.files.size, 0);

  // DB が回復したら、再起動なしで次の GET が終端を書き込む
  harness.db.failFinish = false;
  const recovered = harness.service.get(started.trial.id);
  assert.equal(recovered.status, 200);
  if (recovered.status !== 200) return;
  assert.equal(recovered.trial.recorded, true);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "failed");
  assert.equal(harness.db.rows.get(started.trial.id)?.failureCode, "storage");
  assert.equal(harness.db.rows.get(started.trial.id)?.charged, true);

  // 一覧取得も同じ終端を返す
  const list = harness.service.list("image");
  assert.equal(list.items[0]?.state, "failed");
  assert.equal(list.items[0]?.recorded, true);
  assert.deepEqual(list.artifactUsage, { count: 0, bytes: 0 });
});

test("再起動でレジストリを失った running は applyStored で interrupted に倒す", async () => {
  const harness = createHarness();
  harness.db.rows.set("trial-stale", row({ id: "trial-stale" }));
  await harness.service.applyStored();
  const stale = harness.db.rows.get("trial-stale");
  assert.equal(stale?.state, "interrupted");
  assert.equal(stale?.durationMs, null);
});

test("一覧の取得でも、期限 + 余裕を過ぎたレジストリ外の running だけを interrupted にする", () => {
  const harness = createHarness();
  const now = 1_000;
  // 期限 + 余裕を大きく過ぎた行と、まだ期限内の行を並べる
  const startedAt = now - IMAGE_GENERATION_TIMEOUT_MS * 2;
  harness.db.rows.set("trial-old", row({ id: "trial-old", startedAt }));
  harness.db.rows.set("trial-fresh", row({ id: "trial-fresh", prompt: "new", startedAt: now }));
  const outcome = harness.service.list("image");
  assert.equal(harness.db.rows.get("trial-old")?.state, "interrupted");
  // 期限 + 余裕の内側は触らない
  assert.equal(harness.db.rows.get("trial-fresh")?.state, "running");
  assert.equal(outcome.items.length, 2);
});

test("実行中ジョブは一覧の再照合で中断しない", () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  // 期限を大きく過ぎても、レジストリに居る間は running のまま
  harness.advanceClock(IMAGE_GENERATION_TIMEOUT_MS * 3);
  harness.service.list("image");
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");
});

test("close は実行中の試行を abort して interrupted にする", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  await harness.service.close();
  assert.equal(harness.generations[0]?.aborted(), true);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "interrupted");
  harness.generations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("image") === false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "interrupted");
});

test("開始前の検証は課金前に止め、理由ごとの固定文言を返す", () => {
  assert.equal(createHarness({ generate: false }).start().status, 503);
  const runtime = createHarness({ generate: false }).start();
  assert.equal(runtime.status === 503 ? runtime.error : "", CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE);

  const unconfigured = createHarness({ row: undefined }).start();
  assert.equal(unconfigured.status, 400);
  assert.equal(unconfigured.status === 400 ? unconfigured.error : "", CONTENT_TRIAL_UNCONFIGURED_MESSAGE);

  const disabled = createHarness({ row: { imageModel: "openai/gpt-image-2", enabled: false } }).start();
  assert.equal(disabled.status, 400);
  assert.equal(disabled.status === 400 ? disabled.error : "", CONTENT_DISABLED_MESSAGE);

  const noKey = createHarness({ apiKey: null }).start();
  assert.equal(noKey.status, 503);
  assert.equal(noKey.status === 503 ? noKey.error : "", CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE);

  const outside = createHarness().start("a cat", "openrouter/unknown/model");
  assert.equal(outside.status, 400);
  assert.equal(
    outside.status === 400 ? outside.error : "",
    `${CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE}: openrouter/unknown/model`,
  );

  const empty = createHarness().start("   ");
  assert.equal(empty.status, 400);
  assert.equal(empty.status === 400 ? empty.error : "", CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE);

  const tooLong = createHarness().start("x".repeat(CONTENT_TRIAL_PROMPT_MAX_LENGTH + 1));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.status === 400 ? tooLong.error : "", CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE);

  const kind = createHarness().service.start({ kind: "bgm", model: MODEL, prompt: "a cat" });
  assert.equal(kind.status, 400);
});

test("保存に失敗したら 503 で、実行中のジョブを残さない", () => {
  const harness = createHarness();
  harness.db.failSave = true;
  const outcome = harness.start();
  assert.equal(outcome.status, 503);
  assert.equal(harness.service.running("image"), false);
  assert.equal(harness.generations.length, 0);
});

test("存在しない試行の取得は 404", () => {
  const harness = createHarness();
  const outcome = harness.service.get("trial-missing");
  assert.equal(outcome.status, 404);
  if (outcome.status !== 404) return;
  assert.equal(outcome.error, CONTENT_TRIAL_NOT_FOUND_MESSAGE);
});
