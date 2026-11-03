// コンテンツ生成の試行ジョブ（状態遷移・キャンセル・再照合・成果物の保存と削除）。実 API は呼ばず fake db で検証する。
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentTrialArtifactRow, ContentTrialRow } from "../src/app-db";
import {
  CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE,
  CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE,
  CONTENT_TRIAL_BGM_BUSY_MESSAGE,
  CONTENT_TRIAL_BGM_MODEL_MESSAGE,
  CONTENT_TRIAL_BGM_PROMPT_TOO_LONG_MESSAGE,
  CONTENT_TRIAL_ARTIFACT_FORMAT_MESSAGE,
  CONTENT_TRIAL_ARTIFACT_MISSING_MESSAGE,
  CONTENT_TRIAL_DISK_SHORT_CODE,
  CONTENT_TRIAL_DISK_SHORT_MESSAGE,
  CONTENT_TRIAL_DELETE_RUNNING_MESSAGE,
  CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH,
  CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE,
  CONTENT_TRIAL_IMAGE_MODEL_MESSAGE,
  CONTENT_TRIAL_SPEECH_MODEL_MESSAGE,
  CONTENT_TRIAL_NOT_FOUND_MESSAGE,
  CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE,
  CONTENT_TRIAL_PROMPT_MAX_LENGTH,
  CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE,
  CONTENT_TRIAL_READ_FAILED_MESSAGE,
  CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE,
  CONTENT_TRIAL_SPEECH_PARAMS_MESSAGE,
  CONTENT_TRIAL_SPEECH_VOICE_MESSAGE,
  CONTENT_TRIAL_SPEECH_SPEED_MESSAGE,
  CONTENT_TRIAL_STORAGE_FAILED_MESSAGE,
  CONTENT_TRIAL_UNCONFIGURED_MESSAGE,
  ContentTrialsService,
  type ContentTrialSource,
  type ContentTrialsDb,
} from "../src/content-trials";
import {
  TRIAL_ARTIFACT_MAX_BYTES,
  TRIAL_ARTIFACT_USAGE_WARNING_BYTES,
  trialArtifactFileName,
  type TrialArtifactFormat,
  type TrialArtifactStore,
} from "../src/content-trial-artifacts";
import type { TrialDiskCheck, TrialDiskVerdict } from "../src/content-trial-disk-space";
import { TRIAL_DISK_REQUIRED_BYTES, createTrialDiskCheck } from "../src/content-trial-disk-space";
import { CONTENT_DISABLED_MESSAGE } from "../src/content-disabled";
import {
  acquireBgmGenerationSlot,
  BGM_MAX_CONCURRENT,
  BGM_MODEL,
  BGM_PROMPT_MAX_LENGTH,
  BGM_TIMEOUT_MS,
  BgmGenerationError,
  releaseBgmGenerationSlot,
  type BgmGenerationInput,
} from "../src/bgm";
import { IMAGE_GENERATION_TIMEOUT_MS, type ImageGenerationInput, type ImageGenerationResult } from "../src/images";
import { SPEECH_GENERATION_TIMEOUT_MS, type SpeechGenerationInput, type SpeechGenerationResult } from "../src/speech";

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
  /** 世代の読み取りだけを失敗させる（枠を取った後の例外で共有枠を漏らさないことの確認） */
  failKeyEpoch = false;
  finishCalls = 0;

  readContentKeyEpoch(): number {
    if (this.failKeyEpoch) throw new Error("db epoch boom");
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

  findReusableContentTrial(input: {
    kind: string;
    model: string;
    prompt: string;
    voice: string | null;
    instructions: string | null;
    speed: number | null;
    keyEpoch: number;
  }): ContentTrialRow | undefined {
    const row = this.listContentTrials()
      .filter(
        (candidate) =>
          candidate.kind === input.kind &&
          candidate.model === input.model &&
          candidate.prompt === input.prompt &&
          candidate.voice === input.voice &&
          candidate.instructions === input.instructions &&
          candidate.speed === input.speed &&
          candidate.keyEpoch === input.keyEpoch &&
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

  async write(input: { trialId: string; format: TrialArtifactFormat; bytes: Uint8Array }): Promise<void> {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(trialArtifactFileName(input.trialId, input.format), input.bytes);
    if (this.hold) await this.hold.promise;
  }

  async read(fileName: string): Promise<ArrayBuffer | undefined> {
    const bytes = this.files.get(fileName);
    if (!bytes) return undefined;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  exists(fileName: string): boolean {
    return this.files.has(fileName);
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

interface SpeechGeneration {
  input: SpeechGenerationInput;
  resolve: (result: SpeechGenerationResult) => void;
  aborted: () => boolean;
}

/** BGM の生成器は失敗を例外で返す（チャットのツールと同じ契約） */
interface BgmGeneration {
  input: BgmGenerationInput;
  resolve: (audio: Uint8Array<ArrayBuffer>) => void;
  reject: (error: unknown) => void;
  aborted: () => boolean;
}

/** 音声のカタログ。`voices` が undefined のモデルは自由記述のボイスを受ける */
const SPEECH_MODEL = "google/gemini-3.8-flash-tts";
const SPEECH_VOICES = ["Achernar", "Aoede"];

function row(overrides: Partial<ContentTrialRow> & { id: string }): ContentTrialRow {
  const { id, ...rest } = overrides;
  return {
    id,
    kind: "image",
    model: MODEL,
    prompt: "old",
    voice: null,
    instructions: null,
    speed: null,
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
    speechModels?: readonly string[];
    speechVoices?: readonly string[] | undefined;
    generate?: boolean;
    artifacts?: boolean;
    /** 置き場の空き確認。未指定は判定しない（空きを測れない環境と同じく通す） */
    diskSpace?: TrialDiskCheck;
  } = {},
) {
  const db = new FakeTrialsDb();
  const store = new FakeArtifactStore();
  const generations: Generation[] = [];
  const speechGenerations: SpeechGeneration[] = [];
  const bgmGenerations: BgmGeneration[] = [];
  let now = 1_000;
  const source: ContentTrialSource = {
    read: () => ({
      row: "row" in options ? options.row : { imageModel: "openai/gpt-image-2", enabled: true },
      apiKey: "apiKey" in options ? (options.apiKey ?? null) : KEY,
    }),
    models: () => options.models ?? [MODEL],
    speechModels: () => options.speechModels ?? [SPEECH_MODEL],
    speechVoices: () => ("speechVoices" in options ? options.speechVoices : SPEECH_VOICES),
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
    generateSpeech:
      options.generate === false
        ? undefined
        : (input) => {
            const pending = deferred<SpeechGenerationResult>();
            speechGenerations.push({ input, resolve: pending.resolve, aborted: () => input.signal?.aborted === true });
            return pending.promise;
          },
    artifacts: options.artifacts === false ? undefined : store,
    diskSpace: options.diskSpace,
    generateBgm:
      options.generate === false
        ? undefined
        : (input) =>
            new Promise((resolve, reject) => {
              bgmGenerations.push({ input, resolve, reject, aborted: () => input.signal.aborted });
            }),
    maskError: (text) => text.split(KEY).join("[REDACTED]"),
    now: () => now,
  });
  return {
    db,
    store,
    service,
    generations,
    speechGenerations,
    bgmGenerations,
    advanceClock: (ms: number) => {
      now += ms;
    },
    start: (prompt = "a cat", model = MODEL, force = false) =>
      service.start({ kind: "image", model, prompt, ...(force ? { force: true } : {}) }),
    startSpeech: (
      prompt = "こんにちは",
      params: { model?: string; voice?: string | undefined; instructions?: string | undefined; speed?: number } = {},
    ) =>
      service.start({
        kind: "speech",
        model: params.model ?? SPEECH_MODEL,
        prompt,
        ...(params.voice === undefined ? {} : { voice: params.voice }),
        ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
        ...(params.speed === undefined ? {} : { speed: params.speed }),
      }),
    startBgm: (prompt = "静かな夜のピアノ", model = BGM_MODEL) => service.start({ kind: "bgm", model, prompt }),
    speech: {
      /** 実バイトが mp3 として読める最小の応答（先頭はフレーム同期） */
      mp3: (): SpeechGenerationResult => ({
        ok: true,
        speech: { audio: mp3Bytes(), format: "mp3", contentType: "audio/mpeg" },
      }),
      /** pcm の応答。保存側が RIFF ヘッダを付けて wav にする */
      pcm: (): SpeechGenerationResult => ({
        ok: true,
        speech: { audio: pcmBytes(), format: "pcm", contentType: "audio/pcm", sampleRate: 24_000, channels: 1 },
      }),
    },
  };
}

/** mp3 のフレーム同期で始まる最小のバイト列（保存側は先頭だけを見る） */
function mp3Bytes(): ArrayBuffer {
  return new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]).buffer;
}

/** pcm の生バイト（wav 化すると 44 バイトのヘッダが付く） */
function pcmBytes(): ArrayBuffer {
  return new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer;
}

/** 非同期のジョブが DB へ書くまで待つ（実時間ではなくマイクロタスクだけを回す） */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

test("開始は 202 の running で、世代と artifactState: none を記録し、APIキーは保存しない", async () => {
  const harness = createHarness();
  harness.db.epoch = 3;
  const outcome = await harness.start("a cat on a sofa");
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
  const first = await harness.start();
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

  const second = await harness.start("a dog");
  assert.equal(second.status, 202);
  if (second.status !== 202) return;
  harness.generations[1]?.resolve({ ok: false, code: "invalid_key", message: "画像APIキーが無効です" });
  await until(() => harness.db.rows.get(second.trial.id)?.state === "failed");
  const failed = harness.db.rows.get(second.trial.id);
  assert.equal(failed?.failureCode, "invalid_key");
  assert.equal(failed?.failureMessage, "画像APIキーが無効です");
  assert.equal(failed?.charged, false);

  const third = await harness.start("a bird");
  assert.equal(third.status, 202);
  if (third.status !== 202) return;
  harness.generations[2]?.resolve({ ok: false, code: "aborted", message: "画像生成を中断しました" });
  await until(() => harness.db.rows.get(third.trial.id)?.state === "canceled");
  assert.equal(harness.db.rows.get(third.trial.id)?.failureCode, "aborted");
});

test("同じ入力の保存済み成功は provider を呼ばず 200 で返し、新しい成功を記録しない", async () => {
  const harness = createHarness();
  const first = await harness.start("a cat on a sofa");
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const rowsBefore = harness.db.rows.size;
  const finishesBefore = harness.db.finishCalls;

  const reused = await harness.start("a cat on a sofa");
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
  const again = await harness.start("legacy");
  assert.equal(again.status, 202);
});

test("force の開始は保存済み結果を無視して新しい試行を作る", async () => {
  const harness = createHarness();
  const first = await harness.start("a cat on a sofa");
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");

  const forced = await harness.start("a cat on a sofa", MODEL, true);
  assert.equal(forced.status, 202);
  if (forced.status !== 202) return;
  assert.equal(forced.reused, false);
  assert.notEqual(forced.trial.id, first.trial.id);
  assert.equal(harness.generations.length, 2);
  assert.equal(harness.db.rows.size, 2);
});

test("reuse は現在のキー世代の成功だけを対象にする", async () => {
  const harness = createHarness();
  const first = await harness.start("a cat on a sofa");
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");

  harness.db.epoch = 1;
  const next = await harness.start("a cat on a sofa");
  assert.equal(next.status, 202);
  if (next.status !== 202) return;
  assert.equal(next.reused, false);
  assert.equal(next.trial.keyEpoch, 1);
  assert.equal(harness.generations.length, 2);
  assert.equal(harness.db.rows.size, 2);
});

test("reuse は成果物ファイルが残っている成功だけを対象にする", async () => {
  const harness = createHarness();
  const first = await harness.start("a cat on a sofa");
  if (first.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  harness.store.files.delete(trialArtifactFileName(first.trial.id, "png"));

  const next = await harness.start("a cat on a sofa");
  assert.equal(next.status, 202);
  if (next.status !== 202) return;
  assert.equal(next.reused, false);
  assert.notEqual(next.trial.id, first.trial.id);
  assert.equal(harness.generations.length, 2);
  assert.equal(harness.db.rows.size, 2);
});

test("保存できない形式（svg / html / 不明な MIME）は保存前に拒否し、課金済みの失敗にする", async () => {
  for (const mimeType of ["image/svg+xml", "text/html", "application/octet-stream"]) {
    const harness = createHarness();
    const started = await harness.start();
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
  const started = await harness.start();
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
  const started = await harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  assert.equal(harness.db.rows.get(started.trial.id)?.failureCode, "storage");
});

test("大きすぎる成果物は保存せず、専用の文言で storage の失敗にする", async () => {
  const harness = createHarness();
  const started = await harness.start();
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
  const started = await harness.start();
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
  const started = await harness.start();
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
  const started = await harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: false, code: "unknown", message: `upstream said ${KEY}` });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  const message = harness.db.rows.get(started.trial.id)?.failureMessage ?? "";
  assert.equal(message.includes(KEY), false);
  assert.match(message, /\[REDACTED\]/);
});

test("種別ごとに同時 1 本。実行中は 409 で、provider の呼び出しが終わるまでスロットを解放しない", async () => {
  const harness = createHarness();
  const first = await harness.start();
  assert.equal(first.status, 202);
  if (first.status !== 202) return;
  assert.equal(harness.service.running("image"), true);
  const rejected = await harness.start("another");
  assert.equal(rejected.status, 409);
  if (rejected.status !== 409) return;
  assert.equal(rejected.error, CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE);

  const canceled = harness.service.cancel(first.trial.id);
  assert.equal(canceled.status, 200);
  // キャンセル直後も provider の呼び出しは続く（スロットは解放しない）
  assert.equal(harness.service.running("image"), true);
  assert.equal((await harness.start("another")).status, 409);
  assert.equal(harness.generations[0]?.aborted(), true);

  harness.generations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("image") === false);
  assert.equal((await harness.start("another")).status, 202);
});

test("空き確認の待ちで同時開始が二重に通らない（種別ごとに同時 1 本）", async () => {
  const gate = deferred<void>();
  // 本番と同じ組み立て（`createTrialDiskCheck`）で、`statfs` の応答だけを遅らせる
  const diskSpace = createTrialDiskCheck({
    dir: "/store/trials",
    statfs: async () => {
      await gate.promise;
      return { bsize: 1, bavail: TRIAL_DISK_REQUIRED_BYTES };
    },
  });
  const harness = createHarness({ diskSpace });
  // 空き確認で止まっている間に、同じ種別の開始がもう 1 本届く
  const first = harness.start("a cat");
  const second = harness.start("a cat");
  gate.resolve();
  const outcomes = await Promise.all([first, second]);

  assert.deepEqual(
    outcomes.map((outcome) => outcome.status).sort(),
    [202, 409],
    "待つ間の同時開始で 2 本とも 202 にしない",
  );
  const refused = outcomes.find((outcome) => outcome.status === 409);
  assert.equal(refused && "error" in refused ? refused.error : "", CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE);
  assert.equal(harness.db.rows.size, 1, "running の行は 1 件だけ");
  assert.equal(harness.generations.length, 1, "provider を 2 回呼ばない（二重課金しない）");
});

test("キャンセルは running のときだけ受け付け、遅れて届いた結果で状態を戻さない", async () => {
  const harness = createHarness();
  const started = await harness.start();
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
  const started = await harness.start();
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  const canceled = harness.service.cancel(started.trial.id);
  assert.equal(canceled.status, 409);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "succeeded");
});

test("running の削除は 409 で「先に中断してください」、終端だけ消せる", async () => {
  const harness = createHarness();
  const started = await harness.start();
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
  const started = await harness.start();
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
  const done = await harness.start("done");
  if (done.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(done.trial.id)?.state === "succeeded");
  const started = await harness.start();
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
  const started = await harness.start();
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
  const started = await harness.start();
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
  const started = await harness.start();
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
  const reused = await harness.start();
  assert.equal(reused.status, 200);
  if (reused.status !== 200) return;
  assert.equal(reused.reused, true);
  assert.equal(reused.trial.id, started.trial.id);
  assert.equal(harness.generations.length, 1, "再利用では provider を呼ばない");
});

test("保存容量の警告は 1 GiB を超えたときだけ立ち、しきい値を応答に載せる", async () => {
  const harness = createHarness();
  const stored = (id: string, bytes: number): ContentTrialRow =>
    row({
      id,
      state: "succeeded",
      artifactState: "stored",
      charged: true,
      artifact: {
        path: trialArtifactFileName(id, "png"),
        bytes,
        format: "png",
        width: 1,
        height: 1,
      },
    });
  const below = TRIAL_ARTIFACT_USAGE_WARNING_BYTES - 1;
  harness.db.rows.set(trialId(1), stored(trialId(1), below));

  const under = harness.service.list();
  assert.deepEqual(under.artifactUsage, { count: 1, bytes: below });
  assert.deepEqual(under.artifactWarning, { thresholdBytes: TRIAL_ARTIFACT_USAGE_WARNING_BYTES, warning: false });

  harness.db.rows.set(trialId(1), stored(trialId(1), TRIAL_ARTIFACT_USAGE_WARNING_BYTES));
  assert.equal(harness.service.list().artifactWarning.warning, false, "1 GiB ちょうどでは警告しない");

  harness.db.rows.set(trialId(1), stored(trialId(1), TRIAL_ARTIFACT_USAGE_WARNING_BYTES + 1));
  assert.equal(harness.service.list().artifactWarning.warning, true, "1 GiB を超えたら警告する");

  // 容量表示と警告は、個別削除・全削除の後に同じ一覧で追随する
  const removed = await harness.service.remove(trialId(1));
  assert.equal(removed.status, 200);
  const empty = harness.service.list();
  assert.deepEqual(empty.artifactUsage, { count: 0, bytes: 0 });
  assert.equal(empty.artifactWarning.warning, false);
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
  const started = await harness.start();
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

test("一覧の取得でも、期限 + 余裕を過ぎたレジストリ外の running だけを interrupted にする", async () => {
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

test("実行中ジョブは一覧の再照合で中断しない", async () => {
  const harness = createHarness();
  const started = await harness.start();
  if (started.status !== 202) return;
  // 期限を大きく過ぎても、レジストリに居る間は running のまま
  harness.advanceClock(IMAGE_GENERATION_TIMEOUT_MS * 3);
  harness.service.list("image");
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "running");
});

test("close は実行中の試行を abort して interrupted にする", async () => {
  const harness = createHarness();
  const started = await harness.start();
  if (started.status !== 202) return;
  await harness.service.close();
  assert.equal(harness.generations[0]?.aborted(), true);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "interrupted");
  harness.generations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("image") === false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "interrupted");
});

test("開始前の検証は課金前に止め、理由ごとの固定文言を返す", async () => {
  assert.equal((await createHarness({ generate: false }).start()).status, 503);
  const runtime = await createHarness({ generate: false }).start();
  assert.equal(runtime.status === 503 ? runtime.error : "", CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE);

  const unconfigured = await createHarness({ row: undefined }).start();
  assert.equal(unconfigured.status, 400);
  assert.equal(unconfigured.status === 400 ? unconfigured.error : "", CONTENT_TRIAL_UNCONFIGURED_MESSAGE);

  const disabled = await createHarness({ row: { imageModel: "openai/gpt-image-2", enabled: false } }).start();
  assert.equal(disabled.status, 400);
  assert.equal(disabled.status === 400 ? disabled.error : "", CONTENT_DISABLED_MESSAGE);

  const noKey = await createHarness({ apiKey: null }).start();
  assert.equal(noKey.status, 503);
  assert.equal(noKey.status === 503 ? noKey.error : "", CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE);

  const outside = await createHarness().start("a cat", "openrouter/unknown/model");
  assert.equal(outside.status, 400);
  assert.equal(
    outside.status === 400 ? outside.error : "",
    `${CONTENT_TRIAL_IMAGE_MODEL_MESSAGE}: openrouter/unknown/model`,
  );

  const empty = await createHarness().start("   ");
  assert.equal(empty.status, 400);
  assert.equal(empty.status === 400 ? empty.error : "", CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE);

  const tooLong = await createHarness().start("x".repeat(CONTENT_TRIAL_PROMPT_MAX_LENGTH + 1));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.status === 400 ? tooLong.error : "", CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE);

  const kind = await createHarness().service.start({ kind: "bgm", model: MODEL, prompt: "a cat" });
  assert.equal(kind.status, 400);
});

test("保存に失敗したら 503 で、実行中のジョブを残さない", async () => {
  const harness = createHarness();
  harness.db.failSave = true;
  const outcome = await harness.start();
  assert.equal(outcome.status, 503);
  assert.equal(harness.service.running("image"), false);
  assert.equal(harness.generations.length, 0);
});

test("置き場の空きが足りないときは、行を作らずに開始を拒否する", async () => {
  let verdict: TrialDiskVerdict = "short";
  const harness = createHarness({ diskSpace: async () => verdict });

  const refused = await harness.start("a cat on a sofa");
  assert.equal(refused.status, 503);
  if (refused.status !== 503) return;
  assert.equal(refused.code, CONTENT_TRIAL_DISK_SHORT_CODE);
  assert.equal(refused.error, CONTENT_TRIAL_DISK_SHORT_MESSAGE);
  assert.equal(harness.db.rows.size, 0, "拒否した試行の行を作らない");
  assert.equal(harness.generations.length, 0, "provider を呼ばない");

  verdict = "enough";
  assert.equal((await harness.start("a cat on a sofa")).status, 202, "空きが戻れば同じ入力で開始できる");
});

test("空きが足りなくても、保存済みの同じ入力の再利用は止めない", async () => {
  let verdict: TrialDiskVerdict = "enough";
  const harness = createHarness({ diskSpace: async () => verdict });
  const started = await harness.start("a cat on a sofa");
  if (started.status !== 202) return;
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");

  verdict = "short";
  const reused = await harness.start("a cat on a sofa");
  assert.equal(reused.status, 200);
  if (reused.status !== 200) return;
  assert.equal(reused.reused, true);
  assert.equal(reused.trial.id, started.trial.id);
  assert.equal(harness.generations.length, 1, "再利用は provider を呼ばない");

  const forced = await harness.start("a cat on a sofa", MODEL, true);
  assert.equal(forced.status, 503, "別のテイクは空きが要る");
  assert.equal(harness.db.rows.size, 1);
});

test("空き不足の開始拒否は、保存に失敗した storage の終端と混ざらない", async () => {
  let verdict: TrialDiskVerdict = "short";
  const refusedHarness = createHarness({ diskSpace: async () => verdict });
  const refused = await refusedHarness.start();
  assert.equal(refused.status, 503);
  if (refused.status !== 503) return;
  assert.equal(refused.code, CONTENT_TRIAL_DISK_SHORT_CODE);
  assert.equal(refusedHarness.db.rows.size, 0, "開始していないため課金済みの行も残さない");

  // 生成の後に保存できなかった試行は、行が残り、課金済みの failed + failureCode: storage になる
  verdict = "enough";
  refusedHarness.store.failWrite = true;
  const failed = await refusedHarness.start();
  if (failed.status !== 202) return;
  refusedHarness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => refusedHarness.db.rows.get(failed.trial.id)?.state === "failed");
  const failure = refusedHarness.db.rows.get(failed.trial.id);
  assert.equal(failure?.failureCode, "storage");
  assert.equal(failure?.charged, true);
  assert.equal(failure?.failureMessage, CONTENT_TRIAL_STORAGE_FAILED_MESSAGE);
});

test("空きが足りないときは BGM の共有枠も取らない", async () => {
  let verdict: TrialDiskVerdict = "short";
  const harness = createHarness({ diskSpace: async () => verdict });
  assert.equal((await harness.startBgm()).status, 503);
  verdict = "enough";
  const started = await harness.startBgm();
  assert.equal(started.status, 202, "拒否で枠を漏らさない");
  // 共有枠を次のテストへ残さない（後片付けはキャンセルではなく結果の確定で行う）
  harness.bgmGenerations[0]?.resolve(bgmMp3());
  await until(() => harness.service.running("bgm") === false);
});

test("空きを判定しない構成（未注入）は、これまでどおり開始できる", async () => {
  const harness = createHarness();
  assert.equal((await harness.start()).status, 202);
});

test("存在しない試行の取得は 404", async () => {
  const harness = createHarness();
  const outcome = harness.service.get("trial-missing");
  assert.equal(outcome.status, 404);
  if (outcome.status !== 404) return;
  assert.equal(outcome.error, CONTENT_TRIAL_NOT_FOUND_MESSAGE);
});

// --- 音声の試行（段階 3） ---

test("音声の開始は入力スナップショットを記録し、provider へ本文とパラメーターを渡す", async () => {
  const harness = createHarness();
  harness.db.epoch = 2;
  const outcome = await harness.startSpeech("おはようございます", {
    voice: "Aoede",
    instructions: "落ち着いた声で",
    speed: 1.25,
  });
  assert.equal(outcome.status, 202);
  if (outcome.status !== 202) return;
  assert.equal(outcome.reused, false);
  assert.equal(outcome.trial.kind, "speech");
  assert.equal(outcome.trial.model, SPEECH_MODEL);
  assert.equal(outcome.trial.voice, "Aoede");
  assert.equal(outcome.trial.instructions, "落ち着いた声で");
  assert.equal(outcome.trial.speed, 1.25);
  assert.equal(outcome.trial.keyEpoch, 2);
  // 生成器へは固定 provider と画面の値だけを渡す（APIキーは行に残さない）
  const generation = harness.speechGenerations[0];
  assert.ok(generation);
  assert.equal(generation.input.provider, "openrouter");
  assert.equal(generation.input.model, SPEECH_MODEL);
  assert.equal(generation.input.text, "おはようございます");
  assert.equal(generation.input.voice, "Aoede");
  assert.equal(generation.input.instructions, "落ち着いた声で");
  assert.equal(generation.input.speed, 1.25);
  assert.equal(generation.input.apiKey, KEY);
  const saved = harness.db.rows.get(outcome.trial.id);
  assert.equal(JSON.stringify(saved).includes(KEY), false);
});

test("空のボイスと演技指示は送らず、{voice, instructions} を null として履歴に残す", async () => {
  const harness = createHarness();
  const outcome = await harness.startSpeech("こんにちは", { voice: "", instructions: "  " });
  if (outcome.status !== 202) return;
  const generation = harness.speechGenerations[0];
  assert.equal("voice" in (generation?.input ?? {}), false);
  assert.equal("instructions" in (generation?.input ?? {}), false);
  assert.equal("speed" in (generation?.input ?? {}), false);
  assert.equal(outcome.trial.voice, null);
  assert.equal(outcome.trial.instructions, null);
  assert.equal(outcome.trial.speed, null);
});

test("音声は mp3 と wav を保存し、raw は保存時に確定した形式の MIME で返す", async () => {
  const harness = createHarness();
  const first = await harness.startSpeech("mp3 の本文");
  if (first.status !== 202) return;
  harness.speechGenerations[0]?.resolve(harness.speech.mp3());
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const mp3Row = harness.db.rows.get(first.trial.id);
  assert.equal(mp3Row?.artifactState, "stored");
  assert.equal(mp3Row?.artifact?.format, "mp3");
  assert.equal(mp3Row?.artifact?.width, null);
  assert.equal(mp3Row?.charged, true);
  assert.ok(harness.store.files.has(trialArtifactFileName(first.trial.id, "mp3")));

  const raw = await harness.service.raw(first.trial.id);
  assert.equal(raw.status, 200);
  if (raw.status !== 200) return;
  assert.equal(raw.contentType, "audio/mpeg");
  assert.equal(raw.fileName, `${first.trial.id}.mp3`);

  // pcm は RIFF ヘッダを付けて wav として保存する
  const second = await harness.startSpeech("pcm の本文");
  if (second.status !== 202) return;
  harness.speechGenerations[1]?.resolve(harness.speech.pcm());
  await until(() => harness.db.rows.get(second.trial.id)?.state === "succeeded");
  const wavRow = harness.db.rows.get(second.trial.id);
  assert.equal(wavRow?.artifact?.format, "wav");
  // pcm 4 バイト + 44 バイトのヘッダ
  assert.equal(wavRow?.artifact?.bytes, 48);
  const wavRaw = await harness.service.raw(second.trial.id);
  assert.equal(wavRaw.status === 200 ? wavRaw.contentType : "", "audio/wav");

  // 容量は画像と同じ 1 つの合計に載る
  assert.equal(harness.service.list().artifactUsage.count, 2);
});

test("音声の形式の許可リストは保存前に拒否し、課金済みの storage 失敗にする", async () => {
  // 宣言 MIME と実バイトが食い違う（mp3 と称して wav を返す）応答は保存しない
  for (const speech of [
    { audio: pcmBytes(), format: "mp3" as const, contentType: "audio/pcm" },
    { audio: new Uint8Array([0x00, 0x01, 0x02]).buffer, format: "mp3" as const, contentType: "audio/mpeg" },
    { audio: new Uint8Array(0).buffer, format: "mp3" as const, contentType: "audio/mpeg" },
  ]) {
    const harness = createHarness();
    const started = await harness.startSpeech();
    if (started.status !== 202) return;
    harness.speechGenerations[0]?.resolve({ ok: true, speech });
    await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
    const failed = harness.db.rows.get(started.trial.id);
    assert.equal(failed?.failureCode, "storage");
    assert.equal(failed?.charged, true);
    assert.equal(harness.store.files.size, 0, "拒否した応答は 1 バイトも書かない");
  }
});

test("音声の保存に失敗したら storage の課金済み失敗にし、成功として見せない", async () => {
  const harness = createHarness();
  harness.store.failWrite = true;
  const started = await harness.startSpeech();
  if (started.status !== 202) return;
  harness.speechGenerations[0]?.resolve(harness.speech.mp3());
  await until(() => harness.db.rows.get(started.trial.id)?.state === "failed");
  const failed = harness.db.rows.get(started.trial.id);
  assert.equal(failed?.failureCode, "storage");
  assert.equal(failed?.failureMessage, CONTENT_TRIAL_STORAGE_FAILED_MESSAGE);
  assert.equal(failed?.charged, true);
  assert.equal(harness.store.files.size, 0);

  // 置き場が無い起動（永続化なし）も同じ分類
  const noStore = createHarness({ artifacts: false });
  const started2 = await noStore.startSpeech();
  if (started2.status !== 202) return;
  noStore.speechGenerations[0]?.resolve(noStore.speech.mp3());
  await until(() => noStore.db.rows.get(started2.trial.id)?.state === "failed");
  assert.equal(noStore.db.rows.get(started2.trial.id)?.failureCode, "storage");
});

test("音声の provider の失敗は分類して記録し、aborted だけを canceled にする", async () => {
  for (const [code, state] of [
    ["invalid_key", "failed"],
    ["insufficient_credit", "failed"],
    ["aborted", "canceled"],
  ] as const) {
    const harness = createHarness();
    const started = await harness.startSpeech();
    if (started.status !== 202) return;
    harness.speechGenerations[0]?.resolve({ ok: false, code, message: KEY });
    await until(() => harness.db.rows.get(started.trial.id)?.state === state);
    const row = harness.db.rows.get(started.trial.id);
    assert.equal(row?.failureCode, code);
    assert.equal(row?.charged, false);
    // 履歴に残る文言もマスカーを通す
    assert.equal(row?.failureMessage, "[REDACTED]");
  }
});

test("音声のキャンセルと close は abort し、interrupted は再起動の再照合で倒す", async () => {
  const harness = createHarness();
  const started = await harness.startSpeech();
  if (started.status !== 202) return;
  const canceled = harness.service.cancel(started.trial.id);
  assert.equal(canceled.status, 200);
  assert.equal(harness.speechGenerations[0]?.aborted(), true);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "canceled");
  harness.speechGenerations[0]?.resolve({ ok: false, code: "aborted", message: "中断" });
  await until(() => harness.service.running("speech") === false);
  assert.equal(harness.db.rows.get(started.trial.id)?.state, "canceled");

  const other = createHarness();
  const running = await other.startSpeech();
  if (running.status !== 202) return;
  await other.service.close();
  assert.equal(other.speechGenerations[0]?.aborted(), true);
  assert.equal(other.db.rows.get(running.trial.id)?.state, "interrupted");

  // 期限を過ぎた running（レジストリに居ない＝前のプロセスの取り残し）は一覧の取得で interrupted になる
  const stale = createHarness();
  const staleId = trialId(99);
  stale.db.rows.set(
    staleId,
    row({ id: staleId, kind: "speech", model: SPEECH_MODEL, prompt: "取り残し", startedAt: 1_000 }),
  );
  stale.advanceClock(SPEECH_GENERATION_TIMEOUT_MS + 60_000);
  const list = stale.service.list("speech");
  assert.equal(list.items[0]?.state, "interrupted");
  assert.deepEqual(list.artifactUsage, { count: 0, bytes: 0 });
});

test("同じ入力（本文 + モデル + ボイス + 演技指示 + 話速）の保存済み成功は課金せずに返す", async () => {
  const harness = createHarness({ speechModels: [SPEECH_MODEL, "google/other-tts"] });
  const input = { voice: "Aoede", instructions: "ゆっくり", speed: 0.9 };
  const first = await harness.startSpeech("同じ本文", input);
  if (first.status !== 202) return;
  harness.speechGenerations[0]?.resolve(harness.speech.mp3());
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const rowsBefore = harness.db.rows.size;

  const reused = await harness.startSpeech("同じ本文", input);
  assert.equal(reused.status, 200);
  if (reused.status !== 200) return;
  assert.equal(reused.reused, true);
  assert.equal(reused.trial.id, first.trial.id);
  assert.equal(harness.speechGenerations.length, 1);
  assert.equal(harness.db.rows.size, rowsBefore);

  // ボイス / 演技指示 / 話速 / モデルが違えば再利用せず、新しい試行として開始する
  for (const changed of [
    { voice: "Achernar", instructions: "ゆっくり", speed: 0.9 },
    { voice: "Aoede", instructions: "早口で", speed: 0.9 },
    { voice: "Aoede", instructions: "ゆっくり", speed: 1.1 },
    { voice: "Aoede", instructions: "ゆっくり", speed: 0.9, model: "google/other-tts" },
  ]) {
    const next = await harness.startSpeech("同じ本文", changed);
    assert.equal(next.status, 202, JSON.stringify(changed));
    if (next.status === 202) {
      harness.speechGenerations[harness.speechGenerations.length - 1]?.resolve({
        ok: false,
        code: "unknown",
        message: "止める",
      });
      await until(() => harness.db.rows.get(next.trial.id)?.state !== "running");
    }
  }
  // 本文だけ違っても再利用しない
  assert.equal((await harness.startSpeech("別の本文", input)).status, 202);
});

test("音声の開始前の検証は課金前に止める（カタログ / 宣言ボイス / 話速 / 音声以外のパラメーター）", async () => {
  const outside = await createHarness().startSpeech("x", { model: "unknown/model" });
  assert.equal(outside.status, 400);
  assert.equal(outside.status === 400 ? outside.error : "", `${CONTENT_TRIAL_SPEECH_MODEL_MESSAGE}: unknown/model`);

  const undeclared = await createHarness().startSpeech("x", { voice: "NotAVoice" });
  assert.equal(undeclared.status, 400);
  assert.match(undeclared.status === 400 ? undeclared.error : "", /NotAVoice/);

  const freeform = await createHarness({ speechVoices: undefined }).startSpeech("x", { voice: "any name" });
  assert.equal(freeform.status, 202, "宣言が無いモデルは自由記述を受ける");

  const speed = await createHarness().startSpeech("x", { speed: 0 });
  assert.equal(speed.status, 400);
  assert.equal(speed.status === 400 ? speed.error : "", CONTENT_TRIAL_SPEECH_SPEED_MESSAGE);

  const instructions = await createHarness().startSpeech("x", {
    instructions: "a".repeat(CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH + 1),
  });
  assert.equal(instructions.status, 400);

  // 画像の試行に音声のパラメーターは付けられない
  const image = await createHarness().service.start({ kind: "image", model: MODEL, prompt: "a cat", voice: "Aoede" });
  assert.equal(image.status, 400);
  assert.equal(image.status === 400 ? image.error : "", CONTENT_TRIAL_SPEECH_PARAMS_MESSAGE);

  // 音声の生成器が無い起動は 503
  const unavailable = await createHarness({ generate: false }).startSpeech();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.status === 503 ? unavailable.error : "", CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE);
});

test("画像と音声は種別ごとに 1 本ずつで、種類が違えば並行できる", async () => {
  const harness = createHarness();
  const image = await harness.start("a cat");
  const speech = await harness.startSpeech();
  assert.equal(image.status, 202);
  assert.equal(speech.status, 202);
  assert.equal(harness.service.running("image"), true);
  assert.equal(harness.service.running("speech"), true);
  assert.equal((await harness.start("a dog")).status, 409);
  assert.equal((await harness.startSpeech("別の本文")).status, 409);
  harness.speechGenerations[0]?.resolve(harness.speech.mp3());
  harness.generations[0]?.resolve({ ok: true, image: pngImage() });
  await until(() => harness.service.running("image") === false && harness.service.running("speech") === false);
});

test("成果物の再照合は音声の succeeded + stored だけを残し、画像の形式を音声の行に配信しない", async () => {
  const harness = createHarness();
  const ok = await harness.startSpeech();
  if (ok.status !== 202) return;
  harness.speechGenerations[0]?.resolve(harness.speech.mp3());
  await until(() => harness.db.rows.get(ok.trial.id)?.state === "succeeded");
  // 行の無いファイルは孤児として消える
  harness.store.files.set("trial-000000000000000000000099.mp3", new Uint8Array([1, 2, 3]));
  await harness.service.reconcileArtifacts();
  assert.deepEqual([...harness.store.files.keys()], [trialArtifactFileName(ok.trial.id, "mp3")]);

  // 種別と形式が食い違う行は配信しない（画像の行に mp3 が載っていても 404）
  const wrong = harness.db.rows.get(ok.trial.id)!;
  harness.db.rows.set(ok.trial.id, { ...wrong, kind: "image" });
  const raw = await harness.service.raw(ok.trial.id);
  assert.equal(raw.status, 404);
});

test("400 の文言は入力を反射するときにマスカーを通し、固定の理由は残す", async () => {
  const harness = createHarness();

  // 画像のモデル欄へキーを貼った場合（`provider/id` の形ではない）
  const image = await harness.start("a cat", KEY);
  assert.equal(image.status, 400);
  if (image.status !== 400) return;
  assert.equal(image.error.includes(KEY), false, "キーを反射しない");
  assert.ok(image.error.includes("[REDACTED]"));
  assert.ok(image.error.startsWith(CONTENT_TRIAL_IMAGE_MODEL_MESSAGE), "固定の理由は残す");

  // 音声のモデル欄（カタログ外）
  const speechModel = await harness.startSpeech("こんにちは", { model: KEY });
  assert.equal(speechModel.status, 400);
  if (speechModel.status !== 400) return;
  assert.equal(speechModel.error.includes(KEY), false);
  assert.ok(speechModel.error.includes("[REDACTED]"));

  // 音声のボイス欄（宣言外）
  const voice = await harness.startSpeech("こんにちは", { voice: KEY });
  assert.equal(voice.status, 400);
  if (voice.status !== 400) return;
  assert.equal(voice.error.includes(KEY), false);
  assert.ok(voice.error.includes("[REDACTED]"));
  assert.ok(voice.error.startsWith(CONTENT_TRIAL_SPEECH_VOICE_MESSAGE), "固定の理由は残す");
});

/** BGM の成果物として保存できる最小の MP3（フレーム同期で始まる） */
function bgmMp3(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
}

test("BGM のプロンプトは 1,000 文字を超えると 400 にし、枠を取らない", async () => {
  const harness = createHarness();
  const outcome = await harness.startBgm("a".repeat(BGM_PROMPT_MAX_LENGTH + 1));
  assert.equal(outcome.status, 400);
  assert.equal(outcome.status === 400 ? outcome.error : "", CONTENT_TRIAL_BGM_PROMPT_TOO_LONG_MESSAGE);
  assert.equal(harness.db.rows.size, 0, "行を作らない");
  assert.equal(harness.bgmGenerations.length, 0, "生成しない");
  // 失敗後も共有枠は空いている
  assert.equal(acquireBgmGenerationSlot(), true);
  releaseBgmGenerationSlot();
});

test("BGM の試行は固定モデルとプロンプトだけを記録し、MP3 を保存して成功する", async () => {
  const harness = createHarness();
  const started = await harness.startBgm("静かな夜のピアノ");
  assert.equal(started.status, 202);
  if (started.status !== 202) return;
  assert.equal(started.trial.kind, "bgm");
  assert.equal(started.trial.model, BGM_MODEL);
  assert.equal(started.trial.prompt, "静かな夜のピアノ");
  // BGM に入力スナップショットは無い（音声の 3 列は null）
  assert.equal(started.trial.voice, null);
  assert.equal(started.trial.instructions, null);
  assert.equal(started.trial.speed, null);
  // 生成器へはプロンプトとキーと中断だけを渡す
  const generation = harness.bgmGenerations[0];
  assert.ok(generation);
  assert.equal(generation.input.prompt, "静かな夜のピアノ");
  assert.equal(generation.input.apiKey, KEY);

  generation.resolve(bgmMp3());
  await until(() => harness.db.rows.get(started.trial.id)?.state === "succeeded");
  const succeeded = harness.db.rows.get(started.trial.id);
  assert.equal(succeeded?.artifactState, "stored");
  assert.equal(succeeded?.artifact?.format, "mp3");
  assert.equal(succeeded?.artifact?.bytes, 6);
  // 音声に寸法は無い
  assert.equal(succeeded?.artifact?.width, null);
  assert.equal(succeeded?.artifact?.height, null);
  assert.equal(succeeded?.charged, true);
  // raw 配信は保存時に確定した audio/mpeg
  const raw = await harness.service.raw(started.trial.id);
  assert.equal(raw.status, 200);
  assert.equal(raw.status === 200 ? raw.contentType : "", "audio/mpeg");
  assert.deepEqual(harness.service.list("bgm").artifactUsage, { count: 1, bytes: 6 });
});

test("BGM の結果が mp3 でない / 保存できないときは storage の失敗にし、成功として見せない", async () => {
  // 実バイトが画像（生成器の契約違反）は保存しない
  const notMp3 = createHarness();
  const bad = await notMp3.startBgm();
  if (bad.status !== 202) return;
  notMp3.bgmGenerations[0]?.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await until(() => notMp3.db.rows.get(bad.trial.id)?.state === "failed");
  const failed = notMp3.db.rows.get(bad.trial.id);
  assert.equal(failed?.failureCode, "storage");
  assert.equal(failed?.failureMessage, CONTENT_TRIAL_ARTIFACT_FORMAT_MESSAGE);
  // 生成は成功して課金されているので、再生成で再課金されることを記録する
  assert.equal(failed?.charged, true);
  assert.equal(notMp3.store.files.size, 0, "拒否した結果は 1 バイトも書かない");

  // 置き場の書き込み失敗も同じ分類
  const noDisk = createHarness();
  noDisk.store.failWrite = true;
  const pending = await noDisk.startBgm();
  if (pending.status !== 202) return;
  noDisk.bgmGenerations[0]?.resolve(bgmMp3());
  await until(() => noDisk.db.rows.get(pending.trial.id)?.state === "failed");
  assert.equal(noDisk.db.rows.get(pending.trial.id)?.failureCode, "storage");
  assert.equal(noDisk.db.rows.get(pending.trial.id)?.failureMessage, CONTENT_TRIAL_STORAGE_FAILED_MESSAGE);
});

test("BGM の失敗は provider-failure の分類へ写し、中断は canceled にする", async () => {
  const harness = createHarness();
  const unauthorized = await harness.startBgm();
  if (unauthorized.status !== 202) return;
  harness.bgmGenerations[0]?.reject(new BgmGenerationError("BGM HTTP 401: invalid key", 401));
  await until(() => harness.db.rows.get(unauthorized.trial.id)?.state === "failed");
  assert.equal(harness.db.rows.get(unauthorized.trial.id)?.failureCode, "invalid_key");

  const unknown = await harness.startBgm("別のプロンプト");
  if (unknown.status !== 202) return;
  harness.bgmGenerations[1]?.reject(new Error("BGMのSSEが途中で切断されました"));
  await until(() => harness.db.rows.get(unknown.trial.id)?.state === "failed");
  assert.equal(harness.db.rows.get(unknown.trial.id)?.failureCode, "unknown");
  assert.match(harness.db.rows.get(unknown.trial.id)?.failureMessage ?? "", /途中で切断/);

  // 利用者の中断は canceled（生成器の signal も abort される）
  const canceled = await harness.startBgm("中断するプロンプト");
  if (canceled.status !== 202) return;
  const outcome = harness.service.cancel(canceled.trial.id);
  assert.equal(outcome.status, 200);
  assert.equal(harness.bgmGenerations[2]?.aborted(), true);
  harness.bgmGenerations[2]?.reject(new BgmGenerationError("BGM生成を中断しました"));
  await until(() => harness.service.running("bgm") === false);
  assert.equal(harness.db.rows.get(canceled.trial.id)?.state, "canceled");
  assert.equal(harness.db.rows.get(canceled.trial.id)?.charged, false);
});

test("BGM の running は BGM_TIMEOUT_MS を過ぎた再照合で interrupted になる", async () => {
  const harness = createHarness();
  const staleId = trialId(77);
  harness.db.rows.set(
    staleId,
    row({ id: staleId, kind: "bgm", model: BGM_MODEL, prompt: "取り残し", startedAt: 1_000 }),
  );
  harness.advanceClock(BGM_TIMEOUT_MS + 60_000);
  const list = harness.service.list("bgm");
  assert.equal(list.items[0]?.state, "interrupted");

  // close は実行中の BGM を abort して interrupted にする（枠は provider の呼び出しが終わって返る）
  const running = await harness.startBgm();
  if (running.status !== 202) return;
  await harness.service.close();
  assert.equal(harness.bgmGenerations[0]?.aborted(), true);
  assert.equal(harness.db.rows.get(running.trial.id)?.state, "interrupted");
  harness.bgmGenerations[0]?.reject(new BgmGenerationError("BGM生成を中断しました"));
  await until(() => harness.service.running("bgm") === false);
});

test("BGM の試行はチャットの generate_bgm と同じ同時実行枠を数える", async () => {
  const harness = createHarness();
  // チャットの生成が枠を使い切っている間は、行を作らずに 409 で止める
  assert.equal(acquireBgmGenerationSlot(), true);
  assert.equal(acquireBgmGenerationSlot(), true);
  assert.equal(acquireBgmGenerationSlot(), false, `同時 ${BGM_MAX_CONCURRENT} 件が上限`);
  const busy = await harness.startBgm();
  assert.equal(busy.status, 409);
  assert.equal(busy.status === 409 ? busy.error : "", CONTENT_TRIAL_BGM_BUSY_MESSAGE);
  assert.equal(harness.db.rows.size, 0, "枠が無いときは行を作らない");
  releaseBgmGenerationSlot();
  releaseBgmGenerationSlot();

  // チャット側の 1 本と試行の 1 本で上限に達する（試行用の別枠が無い）
  assert.equal(acquireBgmGenerationSlot(), true);
  const started = await harness.startBgm();
  assert.equal(started.status, 202);
  assert.equal(acquireBgmGenerationSlot(), false, "試行が握っている枠も同じ上限に数える");
  releaseBgmGenerationSlot();

  // 試行が終わると枠が返り、チャットの生成を再び受けられる
  harness.bgmGenerations[0]?.resolve(bgmMp3());
  await until(() => harness.service.running("bgm") === false);
  assert.deepEqual(
    Array.from({ length: BGM_MAX_CONCURRENT }, () => acquireBgmGenerationSlot()),
    [true, true],
  );
  releaseBgmGenerationSlot();
  releaseBgmGenerationSlot();
});

test("BGM の同じプロンプトとモデルの保存済み成功は課金せず、プロンプトが違えば再利用しない", async () => {
  const harness = createHarness();
  const first = await harness.startBgm("同じプロンプト");
  if (first.status !== 202) return;
  harness.bgmGenerations[0]?.resolve(bgmMp3());
  await until(() => harness.db.rows.get(first.trial.id)?.state === "succeeded");
  const rowsBefore = harness.db.rows.size;

  const reused = await harness.startBgm("同じプロンプト");
  assert.equal(reused.status, 200);
  assert.equal(reused.status === 200 ? reused.reused : false, true);
  assert.equal(harness.bgmGenerations.length, 1, "再利用では provider を呼ばない");
  assert.equal(harness.db.rows.size, rowsBefore, "再利用は新しい成功として記録しない");

  // プロンプトが違えば再利用しない（新しい試行として開始し、provider を呼ぶ）
  const changed = await harness.startBgm("違うプロンプト");
  assert.equal(changed.status, 202);
  assert.equal(changed.status === 202 ? changed.reused : true, false);
  assert.equal(harness.bgmGenerations.length, 2);
  if (changed.status !== 202) return;
  harness.service.cancel(changed.trial.id);
  harness.bgmGenerations[1]?.reject(new BgmGenerationError("BGM生成を中断しました"));
  await until(() => harness.service.running("bgm") === false);
});

test("BGM の開始前の検証は固定モデルと音声パラメーターを課金前に止める", async () => {
  const outside = await createHarness().startBgm("x", "openrouter/other-model");
  assert.equal(outside.status, 400);
  assert.equal(
    outside.status === 400 ? outside.error : "",
    `${CONTENT_TRIAL_BGM_MODEL_MESSAGE}: openrouter/other-model`,
  );

  // 音声のパラメーターは BGM へ付けられない
  const params = await createHarness().service.start({
    kind: "bgm",
    model: BGM_MODEL,
    prompt: "x",
    voice: "Aoede",
  });
  assert.equal(params.status, 400);
  assert.equal(params.status === 400 ? params.error : "", CONTENT_TRIAL_SPEECH_PARAMS_MESSAGE);

  // 生成器が未注入の起動は 503（BGM 専用の別枠を作らない）
  const unavailable = await createHarness({ generate: false }).startBgm();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.status === 503 ? unavailable.error : "", CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE);
});

test("世代の読み取りが失敗しても 503 にし、BGM の共有枠を漏らさない", async () => {
  const harness = createHarness();
  harness.db.failKeyEpoch = true;
  // 上限と同じ回数だけ失敗させる。解放されていなければ、この時点で共有枠が張り付く
  for (let attempt = 0; attempt < BGM_MAX_CONCURRENT; attempt += 1) {
    const outcome = await harness.startBgm();
    assert.equal(outcome.status, 503);
    assert.equal(outcome.status === 503 ? outcome.error : "", CONTENT_TRIAL_READ_FAILED_MESSAGE);
  }
  assert.equal(harness.db.rows.size, 0, "行を作らない");

  harness.db.failKeyEpoch = false;
  // チャット側の生成も試行も、同じ枠をそのまま取れる（漏れていない）
  assert.equal(acquireBgmGenerationSlot(), true);
  releaseBgmGenerationSlot();
  const started = await harness.startBgm();
  assert.equal(started.status, 202);
  if (started.status !== 202) return;
  harness.service.cancel(started.trial.id);
  harness.bgmGenerations[0]?.reject(new BgmGenerationError("BGM生成を中断しました"));
  return until(() => harness.service.running("bgm") === false);
});
