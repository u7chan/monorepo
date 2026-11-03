// コンテンツ生成の試行ジョブ（状態遷移・キャンセル・再照合・記録失敗）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentTrialRow } from "../src/app-db";
import {
  CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE,
  CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE,
  CONTENT_TRIAL_DELETE_RUNNING_MESSAGE,
  CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE,
  CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE,
  CONTENT_TRIAL_NOT_FOUND_MESSAGE,
  CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE,
  CONTENT_TRIAL_PROMPT_MAX_LENGTH,
  CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE,
  CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE,
  CONTENT_TRIAL_UNCONFIGURED_MESSAGE,
  ContentTrialsService,
  type ContentTrialSource,
  type ContentTrialsDb,
} from "../src/content-trials";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import { IMAGE_GENERATION_TIMEOUT_MS, type ImageGenerationInput, type ImageGenerationResult } from "../src/images";

const KEY = "sk-trial-dummy-key-0123456789abcdef";
const MODEL = "openrouter/openai/gpt-image-2";

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

function createHarness(
  options: {
    row?: { imageModel: string; enabled: boolean } | undefined;
    apiKey?: string | null;
    models?: readonly string[];
    generate?: boolean;
  } = {},
) {
  const db = new FakeTrialsDb();
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
    maskError: (text) => text.split(KEY).join("[REDACTED]"),
    now: () => now,
  });
  return {
    db,
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
  assert.equal(outcome.trial.state, "running");
  assert.equal(outcome.trial.kind, "image");
  assert.equal(outcome.trial.model, MODEL);
  assert.equal(outcome.trial.prompt, "a cat on a sofa");
  assert.equal(outcome.trial.keyEpoch, 3);
  assert.equal(outcome.trial.artifactState, "none");
  assert.equal(outcome.trial.recorded, true);
  const row = harness.db.rows.get(outcome.trial.id);
  assert.ok(row);
  assert.equal(row.state, "running");
  assert.equal(row.keyEpoch, 3);
  // APIキーは行のどこにも入らない（プロンプトにも入れない）
  assert.equal(JSON.stringify(row).includes(KEY), false);
  // 生成器へは provider / model / prompt / key / signal を渡す
  const generation = harness.generations[0];
  assert.ok(generation);
  assert.equal(generation.input.provider, "openrouter");
  assert.equal(generation.input.model, "openai/gpt-image-2");
  assert.equal(generation.input.apiKey, KEY);
});

test("成功は succeeded、provider の失敗は failed に分類を載せ、中断は canceled になる", async () => {
  const harness = createHarness();
  const first = harness.start();
  assert.equal(first.status, 202);
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const succeeded = harness.db.rows.get(first.trial.id);
  assert.equal(succeeded?.failureCode, null);
  assert.equal(succeeded?.artifactState, "none");
  assert.equal(typeof succeeded?.durationMs, "number");

  const second = harness.start("a dog");
  assert.equal(second.status, 202);
  if (second.status !== 202) return;
  harness.generations[1]?.resolve({ ok: false, code: "invalid_key", message: "画像APIキーが無効です" });
  await until(() => harness.db.rows.get(second.trial.id)?.state === "failed");
  const failed = harness.db.rows.get(second.trial.id);
  assert.equal(failed?.failureCode, "invalid_key");
  assert.equal(failed?.failureMessage, "画像APIキーが無効です");

  const third = harness.start("a bird");
  assert.equal(third.status, 202);
  if (third.status !== 202) return;
  harness.generations[2]?.resolve({ ok: false, code: "aborted", message: "画像生成を中断しました" });
  await until(() => harness.db.rows.get(third.trial.id)?.state === "canceled");
  assert.equal(harness.db.rows.get(third.trial.id)?.failureCode, "aborted");
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

  // 遅れて成功が届いても canceled のまま
  harness.generations[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
  await until(() => harness.service.running("image") === false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "canceled");
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
  harness.generations[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  const canceled = harness.service.cancel(started.trial.id);
  assert.equal(canceled.status, 409);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "succeeded");
});

test("running の削除は 409 で「先に中断してください」、終端だけ消せる", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  const rejected = harness.service.remove(started.trial.id);
  assert.equal(rejected.status, 409);
  if (rejected.status !== 409) return;
  assert.equal(rejected.error, CONTENT_TRIAL_DELETE_RUNNING_MESSAGE);

  harness.service.cancel(started.trial.id);
  harness.generations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("image") === false);
  const removed = harness.service.remove(started.trial.id);
  assert.equal(removed.status, 200);
  if (removed.status !== 200) return;
  assert.equal(removed.removed, 1);
  assert.equal(harness.db.rows.has(started.trial.id), false);
  const missing = harness.service.remove(started.trial.id);
  assert.equal(missing.status, 404);
  if (missing.status !== 404) return;
  assert.equal(missing.error, CONTENT_TRIAL_NOT_FOUND_MESSAGE);
});

test("すべて削除は終端だけを対象にし、実行中は残す", async () => {
  const harness = createHarness();
  harness.db.rows.set("trial-done", {
    id: "trial-done",
    kind: "image",
    model: MODEL,
    prompt: "old",
    state: "succeeded",
    keyEpoch: 0,
    artifactState: "none",
    failureCode: null,
    failureMessage: null,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
  });
  const started = harness.start();
  if (started.status !== 202) return;
  const outcome = harness.service.removeAll();
  assert.equal(outcome.status, 200);
  assert.equal(outcome.removed, 1);
  assert.equal(harness.db.rows.has("trial-done"), false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");
});

test("再起動でレジストリを失った running は applyStored で interrupted に倒す", async () => {
  const harness = createHarness();
  harness.db.rows.set("trial-stale", {
    id: "trial-stale",
    kind: "image",
    model: MODEL,
    prompt: "old",
    state: "running",
    keyEpoch: 0,
    artifactState: "none",
    failureCode: null,
    failureMessage: null,
    startedAt: 1,
    finishedAt: null,
    durationMs: null,
  });
  await harness.service.applyStored();
  const row = harness.db.rows.get("trial-stale");
  assert.equal(row?.state, "interrupted");
  assert.equal(row?.durationMs, null);
});

test("一覧の取得でも、期限 + 余裕を過ぎたレジストリ外の running だけを interrupted にする", () => {
  const harness = createHarness();
  const now = 1_000;
  // 期限 + 余裕を大きく過ぎた行と、まだ期限内の行を並べる
  const startedAt = now - IMAGE_GENERATION_TIMEOUT_MS * 2;
  harness.db.rows.set("trial-old", {
    id: "trial-old",
    kind: "image",
    model: MODEL,
    prompt: "old",
    state: "running",
    keyEpoch: 0,
    artifactState: "none",
    failureCode: null,
    failureMessage: null,
    startedAt,
    finishedAt: null,
    durationMs: null,
  });
  harness.db.rows.set("trial-fresh", {
    id: "trial-fresh",
    kind: "image",
    model: MODEL,
    prompt: "new",
    state: "running",
    keyEpoch: 0,
    artifactState: "none",
    failureCode: null,
    failureMessage: null,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
  });
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

test("終端の記録に失敗してもメモリの終端を返し、次の一覧取得で記録を再試行する", async () => {
  const harness = createHarness();
  const started = harness.start();
  if (started.status !== 202) return;
  harness.db.failFinish = true;
  harness.generations[0]?.resolve({ ok: true, image: { mimeType: "image/png", data: "AAAA" } });
  await until(() => harness.service.running("image") === false);

  const view = harness.service.get(started.trial.id);
  assert.equal(view.status, 200);
  if (view.status !== 200) return;
  assert.equal(view.trial.state, "succeeded");
  assert.equal(view.trial.recorded, false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");

  // DB が回復したら、再起動なしで次の GET が終端を書き込む
  harness.db.failFinish = false;
  const recovered = harness.service.get(started.trial.id);
  assert.equal(recovered.status, 200);
  if (recovered.status !== 200) return;
  assert.equal(recovered.trial.recorded, true);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "succeeded");

  // 一覧取得も同じ終端を返す
  const list = harness.service.list("image");
  assert.equal(list.items[0]?.state, "succeeded");
  assert.equal(list.items[0]?.recorded, true);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "succeeded");
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
