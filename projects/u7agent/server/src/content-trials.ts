/**
 * 設定 → コンテンツ生成の試行ジョブ。画面の寿命に縛られず、リクエストの `AbortSignal` にも結び付けない
 * （明示キャンセルとプロセスの close だけが中断する）。状態はメモリのレジストリとアプリ DB の
 * `content_trials` の両方で持ち、再起動でレジストリを失った `running` は `interrupted` に倒す。
 * 成果物はアプリデータ領域の `<storeDir>/trials` に `<trialId>.<ext>` で置き、行にはメタデータだけを持つ
 * （契約は docs/api-settings.md）。
 */
import { messageFor } from "./http";
import { CONTENT_DISABLED_MESSAGE } from "./content-disabled";
import {
  isTrialId,
  prepareTrialImageArtifact,
  prepareTrialSpeechArtifact,
  trialArtifactContentType,
  trialArtifactFileName,
  trialArtifactFormatAllowed,
  trialArtifactFormatOf,
  trialArtifactIdOfFileName,
  type TrialArtifactFormat,
  type TrialArtifactRejectReason,
  type TrialArtifactStore,
} from "./content-trial-artifacts";
import { IMAGE_GENERATION_TIMEOUT_MS, type ImageGenerationInput, type ImageGenerationResult } from "./images";
import {
  SPEECH_GENERATION_TIMEOUT_MS,
  SPEECH_PROVIDER_ID,
  SPEECH_TEXT_MAX_LENGTH,
  type SpeechGenerationInput,
  type SpeechGenerationResult,
} from "./speech";
import { PROVIDER_FAILURE_CODES } from "./provider-failure";
import type { ContentTrialArtifactRow, ContentTrialRow } from "./app-db";

/** 試行の種別。BGM は最後の段階で足す */
export const CONTENT_TRIAL_KINDS = ["image", "speech"] as const;
export type ContentTrialKind = (typeof CONTENT_TRIAL_KINDS)[number];

/** 終端状態は不変で、`running` からしか遷移しない */
export const CONTENT_TRIAL_STATES = ["running", "succeeded", "failed", "canceled", "interrupted"] as const;
export type ContentTrialState = (typeof CONTENT_TRIAL_STATES)[number];

/** 成果物の状態。`stored` は「保存に成功し、`succeeded` として確定した」ことを表す */
export const CONTENT_TRIAL_ARTIFACT_STATES = ["none", "stored"] as const;
export type ContentTrialArtifactState = (typeof CONTENT_TRIAL_ARTIFACT_STATES)[number];

/**
 * 試行の失敗分類。provider の分類に、生成は成功したが成果物を保存できなかった `storage` を足す
 * （保存できていない結果を成功として見せない）。
 */
export const CONTENT_TRIAL_FAILURE_CODES = [...PROVIDER_FAILURE_CODES, "storage"] as const;
export type ContentTrialFailureCode = (typeof CONTENT_TRIAL_FAILURE_CODES)[number];

/** プロンプトの上限。provider の上限ではなく、履歴に残す本文としての歯止め */
export const CONTENT_TRIAL_PROMPT_MAX_LENGTH = 4_000;

/** 音声の演技指示の上限。本文と同じ上限を課金前に見る */
export const CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH = SPEECH_TEXT_MAX_LENGTH;

export const CONTENT_TRIAL_NOT_FOUND_MESSAGE = "試行が見つかりません";
export const CONTENT_TRIAL_KIND_UNSUPPORTED_MESSAGE = "この種別の試行はまだ実行できません";
export const CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE = "この種別の試行が実行中です。完了するか中断してください";
export const CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE = "この試行はすでに終了しています";
export const CONTENT_TRIAL_DELETE_RUNNING_MESSAGE = "先に中断してください";
export const CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE = "ランタイムが利用できないため、試行を実行できません";
export const CONTENT_TRIAL_UNCONFIGURED_MESSAGE = "コンテンツ生成のAPIキーが未設定です。先にキーを登録してください";
export const CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE =
  "保存済みのAPIキーを使えないため、試行を実行できません。設定を確認してください";
export const CONTENT_TRIAL_READ_FAILED_MESSAGE = "コンテンツ生成の設定を読み取れないため、試行を実行できません";
export const CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE = "カタログに無い画像モデルは試行できません";
export const CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE = "プロンプトを入力してください（クレジットは消費していません）";
export const CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE = `プロンプトが長すぎます（${CONTENT_TRIAL_PROMPT_MAX_LENGTH.toLocaleString("en-US")} 文字まで。クレジットは消費していません）`;
export const CONTENT_TRIAL_RECORD_FAILED_MESSAGE = "試行の状態をアプリデータへ記録できませんでした";
export const CONTENT_TRIAL_STORAGE_FAILED_MESSAGE =
  "生成は完了しましたが、結果を保存できませんでした（課金済み）。もう一度生成すると再課金されます";
export const CONTENT_TRIAL_ARTIFACT_TOO_LARGE_MESSAGE =
  "生成は完了しましたが、結果が大きすぎて保存できませんでした（課金済み）。もう一度生成すると再課金されます";
export const CONTENT_TRIAL_ARTIFACT_FORMAT_MESSAGE =
  "生成は完了しましたが、保存できない形式でした（課金済み）。もう一度生成すると再課金されます";
export const CONTENT_TRIAL_ARTIFACT_MISSING_MESSAGE = "この試行には保存された結果がありません";
export const CONTENT_TRIAL_SPEECH_VOICE_MESSAGE =
  "このモデルが宣言していないボイスは試行できません（クレジットは消費していません）";
export const CONTENT_TRIAL_SPEECH_INSTRUCTIONS_TOO_LONG_MESSAGE = `演技指示が長すぎます（${CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US")} 文字まで。クレジットは消費していません）`;
export const CONTENT_TRIAL_SPEECH_SPEED_MESSAGE =
  "話速は 0 より大きい数値で指定してください（クレジットは消費していません）";
export const CONTENT_TRIAL_SPEECH_PARAMS_MESSAGE = "話速・演技指示・ボイスは音声の試行だけに指定できます";

/**
 * `running` のまま残った行を一覧取得時に再照合する条件。provider の期限に余裕を足した時刻を過ぎ、
 * かつレジストリにも居ない行だけを倒す（生きているジョブを一覧の取得で中断しない）。
 */
const RECONCILE_MARGIN_MS = 30_000;
/** 一覧の取得ごとに DB / ディスクを書き換えないための間引き */
const RECONCILE_INTERVAL_MS = 5_000;

/** 試行 1 件の応答形。`artifact` は保存済みのときだけ非 null で、置き場のパスは載せない */
export interface ContentTrialView {
  id: string;
  kind: ContentTrialKind;
  /** 送信時のモデル (`provider/id` か音声のカタログ id)。現在の保存値とは混ぜない */
  model: string;
  prompt: string;
  /** 音声の入力スナップショット。画像の行は 3 つとも null */
  voice: string | null;
  instructions: string | null;
  speed: number | null;
  state: ContentTrialState;
  keyEpoch: number;
  artifactState: ContentTrialArtifactState;
  artifact: ContentTrialArtifactView | null;
  /** 生成が成功して課金されたか（保存に失敗した成功も true） */
  charged: boolean;
  failureCode: ContentTrialFailureCode | null;
  failureMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  /** 終端状態を DB へ記録できたか。false の間はメモリの状態を優先して返す */
  recorded: boolean;
}

export interface ContentTrialArtifactView {
  format: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

/** 保存容量。`succeeded` かつ保存済みの行だけを DB のバイト数で合計する */
export interface ContentTrialArtifactUsage {
  count: number;
  bytes: number;
}

/** 保存容量の集計。DB が読めないときは 0 件として扱う（一覧は返す） */
const EMPTY_USAGE: ContentTrialArtifactUsage = { count: 0, bytes: 0 };

export interface ContentTrialsDb {
  readContentKeyEpoch(): number;
  saveContentTrial(row: ContentTrialRow): void;
  finishContentTrial(input: {
    id: string;
    state: string;
    failureCode: string | null;
    failureMessage: string | null;
    finishedAt: number;
    durationMs: number | null;
    charged: boolean;
    artifact: ContentTrialArtifactRow | null;
  }): boolean;
  readContentTrial(id: string): ContentTrialRow | undefined;
  listContentTrials(kind?: string): ContentTrialRow[];
  findReusableContentTrial(input: {
    kind: string;
    model: string;
    prompt: string;
    voice: string | null;
    instructions: string | null;
    speed: number | null;
  }): ContentTrialRow | undefined;
  readContentTrialArtifactUsage(): ContentTrialArtifactUsage;
  deleteContentTrial(id: string): boolean;
  deleteTerminalContentTrials(kind?: string): number;
  interruptRunningContentTrials(now: number): number;
}

/**
 * 試行の実行に要る現在値の読み口。行が無ければ undefined（未設定）で、キーは応答・ログへ出さない。
 * 設定サービスが同じロックの外で読める形で渡す。
 */
export interface ContentTrialSource {
  read(): { row: { imageModel: string; enabled: boolean } | undefined; apiKey: string | null };
  /** カタログに載っている画像モデル (`provider/id`)。provider も含めて照合する */
  models(): readonly string[];
  /** カタログに載っている音声モデルの id */
  speechModels(): readonly string[];
  /** そのモデルが宣言しているボイス。宣言が無いモデルは undefined（自由記述を受ける） */
  speechVoices(model: string): readonly string[] | undefined;
}

export interface ContentTrialsOptions {
  db: ContentTrialsDb;
  source: ContentTrialSource;
  /** 画像の生成器（PiBff が持つ）。未注入（ランタイムなしで起動）は runtime 不可と同じ 503 */
  generateImage?: ((input: ImageGenerationInput) => Promise<ImageGenerationResult>) | undefined;
  /** 音声の生成器。未注入は画像と同じく 503 */
  generateSpeech?: ((input: SpeechGenerationInput) => Promise<SpeechGenerationResult>) | undefined;
  /** 成果物の置き場。未注入（永続化なしで起動）は保存に失敗したものとして `storage` で倒す */
  artifacts?: TrialArtifactStore | undefined;
  /** ログ・状態へ出す前の文言境界 */
  maskError: (text: string) => string;
  /** 時計。テストで進める */
  now?: () => number;
}

export type ContentTrialStartOutcome =
  | { status: 200 | 202; trial: ContentTrialView; reused: boolean }
  | { status: 400 | 409 | 503; error: string };

export type ContentTrialReadOutcome = { status: 200; trial: ContentTrialView } | { status: 404; error: string };

export type ContentTrialListOutcome = {
  status: 200;
  items: ContentTrialView[];
  keyEpoch: number;
  artifactUsage: ContentTrialArtifactUsage;
};

export type ContentTrialRemoveOutcome =
  | { status: 200; removed: number }
  | { status: 404; error: string }
  | { status: 409; error: string };

export type ContentTrialRawOutcome =
  | { status: 200; bytes: ArrayBuffer; contentType: string; fileName: string }
  | { status: 404; error: string };

/** メモリ上の終端状態。DB へ書けなかった間も GET / 一覧はここを優先して返す */
interface MemoryTerminal {
  state: Exclude<ContentTrialState, "running">;
  failureCode: ContentTrialFailureCode | null;
  failureMessage: string | null;
  charged: boolean;
  finishedAt: number;
  durationMs: number | null;
  recorded: boolean;
}

interface RunningJob {
  id: string;
  kind: ContentTrialKind;
  controller: AbortController;
  /** 終端を決めた時点で埋まる。以降に届いた結果は破棄する */
  terminal: MemoryTerminal | null;
}

/** 開始要求から確定した、生成器へ渡す入力。行にも同じ値を入力スナップショットとして書く */
interface TrialTarget {
  kind: ContentTrialKind;
  provider: string;
  model: string;
  prompt: string;
  apiKey: string;
  voice: string | null;
  instructions: string | null;
  speed: number | null;
}

/** 終端の決定内容。成果物は `succeeded` のときだけ入る（DB へは状態と 1 文で書く） */
interface TerminalDecision {
  state: Exclude<ContentTrialState, "running">;
  failureCode: ContentTrialFailureCode | null;
  failureMessage: string | null;
  charged: boolean;
  artifact: ContentTrialArtifactRow | null;
}

export class ContentTrialsService {
  #db: ContentTrialsDb;
  #source: ContentTrialSource;
  #generateImage: ((input: ImageGenerationInput) => Promise<ImageGenerationResult>) | undefined;
  #generateSpeech: ((input: SpeechGenerationInput) => Promise<SpeechGenerationResult>) | undefined;
  #artifacts: TrialArtifactStore | undefined;
  #maskError: (text: string) => string;
  #now: () => number;
  /** 実行中（終端を決めた後も provider の呼び出しが終わるまで残る）ジョブ。スロットの所有者 */
  #jobs = new Map<string, RunningJob>();
  /**
   * DB へ記録できなかった終端。ジョブがレジストリから消えた後も、GET / 一覧はここを優先して返し、
   * 記録に成功するまで捨てない（再起動なしで DB の回復へ収束させる）。
   */
  #terminals = new Map<string, MemoryTerminal>();
  /** 最初の一覧取得では必ず再照合する */
  #lastReconcileAt = Number.NEGATIVE_INFINITY;
  /** 置き場の再照合を積み上げない（一覧の取得は同期的に返す） */
  #sweeping = false;

  constructor(options: ContentTrialsOptions) {
    this.#db = options.db;
    this.#source = options.source;
    this.#generateImage = options.generateImage;
    this.#generateSpeech = options.generateSpeech;
    this.#artifacts = options.artifacts;
    this.#maskError = options.maskError;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 起動時の再照合。レジストリは空なので、`running` の行はすべて前のプロセスの取り残しとして
   * `interrupted` に倒す（再開はしない）。倒した後に置き場を照合し、`succeeded` 以外の行にひも付く
   * 中途ファイルと、行の無いファイルを消す。
   */
  async applyStored(): Promise<void> {
    try {
      const interrupted = this.#db.interruptRunningContentTrials(this.#now());
      if (interrupted > 0) console.warn(`[u7agent] content trials interrupted on startup: ${interrupted}`);
    } catch (error) {
      // 倒せなくても起動は続ける。一覧の取得時の再照合と、次の起動で同じ結果になる
      console.warn(`[u7agent] content trials reconcile failed: ${this.#maskError(messageFor(error))}`);
    }
    const removed = await this.reconcileArtifacts();
    if (removed > 0) console.warn(`[u7agent] content trial artifacts removed on startup: ${removed}`);
  }

  /** 種別の実行中ジョブ。終端を決めた後も provider の呼び出しが終わるまで数える（スロットを解放しない） */
  running(kind: ContentTrialKind): boolean {
    for (const job of this.#jobs.values()) {
      if (job.kind === kind) return true;
    }
    return false;
  }

  /** 種別の生成器が注入されているか。未注入は runtime 不可と同じ 503 にする */
  #generatorOf(kind: ContentTrialKind): boolean {
    return kind === "speech" ? this.#generateSpeech !== undefined : this.#generateImage !== undefined;
  }

  /** 種別ごとの期限。`running` の取り残しを再照合で倒す時刻に使う */
  #timeoutOf(kind: string): number {
    return kind === "speech" ? SPEECH_GENERATION_TIMEOUT_MS : IMAGE_GENERATION_TIMEOUT_MS;
  }

  /** 試行の開始。応答は開始直後（202）で、状態は GET で取る */
  start(input: {
    kind: string;
    model: string;
    prompt: string;
    voice?: string | undefined;
    instructions?: string | undefined;
    speed?: number | undefined;
  }): ContentTrialStartOutcome {
    if (!isTrialKind(input.kind)) return { status: 400, error: CONTENT_TRIAL_KIND_UNSUPPORTED_MESSAGE };
    const kind = input.kind;
    const prompt = input.prompt;
    if (prompt.trim() === "") return { status: 400, error: CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE };
    if (prompt.length > CONTENT_TRIAL_PROMPT_MAX_LENGTH)
      return { status: 400, error: CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE };
    const params = trialParametersOf(kind, input);
    if ("error" in params) return { status: 400, error: params.error };

    const route = generationRouteOf(kind, input.model);
    if (route === null) {
      return { status: 400, error: `${CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE}: ${input.model}` };
    }
    // 画像と音声で照合先が違う（画像は `provider/id`、音声はカタログの id と宣言ボイス）
    if (kind === "image") {
      if (!this.#source.models().includes(input.model)) {
        return { status: 400, error: `${CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE}: ${input.model}` };
      }
    } else {
      if (!this.#source.speechModels().includes(input.model)) {
        return { status: 400, error: `${CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE}: ${input.model}` };
      }
      const declared = this.#source.speechVoices(input.model);
      if (declared && params.voice !== null && !declared.includes(params.voice)) {
        return { status: 400, error: `${CONTENT_TRIAL_SPEECH_VOICE_MESSAGE}: ${params.voice}` };
      }
    }

    if (this.running(kind)) return { status: 409, error: CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE };
    if (!this.#generatorOf(kind)) return { status: 503, error: CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE };
    let snapshot: ReturnType<ContentTrialSource["read"]>;
    try {
      snapshot = this.#source.read();
    } catch (error) {
      console.warn(`[u7agent] content trials read failed: ${this.#maskError(messageFor(error))}`);
      return { status: 503, error: CONTENT_TRIAL_READ_FAILED_MESSAGE };
    }
    if (!snapshot.row) return { status: 400, error: CONTENT_TRIAL_UNCONFIGURED_MESSAGE };
    // OFF は「課金も止める」。ツールへ返すのと同じ文言で止める
    if (!snapshot.row.enabled) return { status: 400, error: CONTENT_DISABLED_MESSAGE };
    if (snapshot.apiKey === null) return { status: 503, error: CONTENT_TRIAL_KEY_UNAVAILABLE_MESSAGE };

    // 同じ入力の保存済み成功があれば provider を呼ばない（課金しない。新しい成功としても記録しない）。
    // 音声は本文に加えてモデル・ボイス・演技指示・話速も一致するときだけ再利用する
    const reused = this.#reusable({
      kind,
      model: input.model,
      prompt,
      voice: params.voice,
      instructions: params.instructions,
      speed: params.speed,
    });
    if (reused) return { status: 200, trial: this.#view(reused), reused: true };

    const startedAt = this.#now();
    const row: ContentTrialRow = {
      id: newTrialId(),
      kind,
      model: input.model,
      prompt,
      voice: params.voice,
      instructions: params.instructions,
      speed: params.speed,
      state: "running",
      keyEpoch: this.#db.readContentKeyEpoch(),
      artifactState: "none",
      charged: false,
      artifact: null,
      failureCode: null,
      failureMessage: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
    };
    try {
      this.#db.saveContentTrial(row);
    } catch (error) {
      console.warn(`[u7agent] content trial save failed: ${this.#maskError(messageFor(error))}`);
      return { status: 503, error: CONTENT_TRIAL_RECORD_FAILED_MESSAGE };
    }
    const job: RunningJob = { id: row.id, kind, controller: new AbortController(), terminal: null };
    this.#jobs.set(row.id, job);
    // 応答は開始直後（202）に返し、ジョブの完了は待たない
    void this.#run(job, {
      kind,
      provider: route.provider,
      model: route.model,
      prompt,
      apiKey: snapshot.apiKey,
      voice: params.voice,
      instructions: params.instructions,
      speed: params.speed,
    });
    return { status: 202, trial: this.#view(row), reused: false };
  }

  /** 1 件の取得。終端の記録に失敗したジョブはメモリの状態を優先して返す */
  get(id: string): ContentTrialReadOutcome {
    this.#reconcileIfDue();
    this.#retryUnrecorded();
    let row: ContentTrialRow | undefined;
    try {
      row = this.#db.readContentTrial(id);
    } catch (error) {
      console.warn(`[u7agent] content trial read failed: ${this.#maskError(messageFor(error))}`);
      throw error;
    }
    if (!row) return { status: 404, error: CONTENT_TRIAL_NOT_FOUND_MESSAGE };
    return { status: 200, trial: this.#view(row) };
  }

  /** 一覧。取得のたびに（間引いて）`running` の取り残しと置き場を再照合し、DB 回復後は終端の記録を再試行する */
  list(kind?: string): ContentTrialListOutcome {
    this.#reconcileIfDue();
    this.#retryUnrecorded();
    const rows = this.#db.listContentTrials(kind);
    return {
      status: 200,
      items: rows.map((row) => this.#view(row)),
      keyEpoch: this.#db.readContentKeyEpoch(),
      artifactUsage: this.#usage(),
    };
  }

  /**
   * 保存済みの成果物。id だけを受け、保存時に確定した形式の MIME で返す（パスは受け取らない）。
   * `succeeded` + `stored` 以外の行、行の id と一致しない保存名、置き場に無いファイルは 404。
   */
  async raw(id: string): Promise<ContentTrialRawOutcome> {
    let row: ContentTrialRow | undefined;
    try {
      row = this.#db.readContentTrial(id);
    } catch (error) {
      console.warn(`[u7agent] content trial read failed: ${this.#maskError(messageFor(error))}`);
      throw error;
    }
    const format = row ? storedFormatOf(row) : undefined;
    if (!row || !format || !this.#artifacts) return { status: 404, error: CONTENT_TRIAL_ARTIFACT_MISSING_MESSAGE };
    // 保存名は行の id と形式から作り直す（行のパスをそのまま使わない）
    const fileName = trialArtifactFileName(row.id, format);
    const bytes = await this.#artifacts.read(fileName);
    if (!bytes) return { status: 404, error: CONTENT_TRIAL_ARTIFACT_MISSING_MESSAGE };
    return { status: 200, bytes, contentType: trialArtifactContentType(format), fileName };
  }

  /**
   * キャンセル。`running` のときだけ受け付け、その場で abort して `canceled` を確定する。
   * スロットは provider の呼び出しが終わるまで解放しない（`#jobs` から消さない）。
   */
  cancel(id: string): ContentTrialReadOutcome | { status: 409; error: string } {
    const job = this.#jobs.get(id);
    if (!job && this.#terminals.has(id)) return { status: 409, error: CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE };
    if (job) {
      if (job.terminal !== null) return { status: 409, error: CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE };
      this.#settle(job, {
        state: "canceled",
        failureCode: "aborted",
        failureMessage: null,
        // 中断時点の課金は保証できないため、成功したと言い切れない限り課金済みにしない
        charged: false,
        artifact: null,
      });
      job.controller.abort();
      let row: ContentTrialRow;
      try {
        row = this.#db.readContentTrial(id) ?? this.#rowOf(job);
      } catch (error) {
        console.warn(`[u7agent] content trial read failed: ${this.#maskError(messageFor(error))}`);
        row = this.#rowOf(job);
      }
      return { status: 200, trial: this.#view(row) };
    }
    let row: ContentTrialRow | undefined;
    try {
      row = this.#db.readContentTrial(id);
    } catch (error) {
      console.warn(`[u7agent] content trial read failed: ${this.#maskError(messageFor(error))}`);
      throw error;
    }
    if (!row) return { status: 404, error: CONTENT_TRIAL_NOT_FOUND_MESSAGE };
    // レジストリに無い `running` は前のプロセスの取り残し。中断として倒してから終端として返す
    if (row.state === "running") {
      this.#interrupt(row);
      return { status: 409, error: CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE };
    }
    return { status: 409, error: CONTENT_TRIAL_ALREADY_TERMINAL_MESSAGE };
  }

  /**
   * 個別削除。終端状態だけを受け付け、`running` は 409（先に中断してもらう）。
   * 行を消してからその行の成果物を消し、消し残しは再照合に任せる。
   */
  async remove(id: string): Promise<ContentTrialRemoveOutcome> {
    let row: ContentTrialRow | undefined;
    try {
      row = this.#db.readContentTrial(id);
    } catch (error) {
      console.warn(`[u7agent] content trial read failed: ${this.#maskError(messageFor(error))}`);
      throw error;
    }
    if (!row) return { status: 404, error: CONTENT_TRIAL_NOT_FOUND_MESSAGE };
    if (row.state === "running") return { status: 409, error: CONTENT_TRIAL_DELETE_RUNNING_MESSAGE };
    const removed = this.#db.deleteContentTrial(id) ? 1 : 0;
    if (removed > 0) await this.reconcileArtifacts();
    return { status: 200, removed };
  }

  /** 全削除。`running` は対象にしない（終端状態だけを消し、その行の成果物も消す） */
  async removeAll(kind?: string): Promise<{ status: 200; removed: number }> {
    const removed = this.#db.deleteTerminalContentTrials(kind);
    await this.reconcileArtifacts();
    return { status: 200, removed };
  }

  /**
   * 置き場の再照合。**`succeeded` + `stored` の行のファイルだけを残し**、それ以外の行にひも付くファイルと
   * 行の無いファイルを消す。実行中レジストリに居る trial のファイルは、保存直後で終端の DB 更新がまだでも
   * 消さない（一覧の取得が正常な保存を壊さない）。消した件数を返す。
   */
  async reconcileArtifacts(): Promise<number> {
    const store = this.#artifacts;
    if (!store) return 0;
    let files: string[];
    try {
      files = await store.list();
    } catch (error) {
      console.warn(`[u7agent] content trial artifacts reconcile failed: ${this.#maskError(messageFor(error))}`);
      return 0;
    }
    if (files.length === 0) return 0;
    // 行の一覧はファイル一覧を待った**後**に読む。待つ間にジョブが `succeeded` へ確定して
    // `#jobs` から外れるため、古い一覧で keep を作ると、確定済みのファイルを中途ファイルとして消してしまう
    let rows: ContentTrialRow[];
    try {
      rows = this.#db.listContentTrials();
    } catch (error) {
      console.warn(`[u7agent] content trial artifacts reconcile failed: ${this.#maskError(messageFor(error))}`);
      return 0;
    }
    const keep = new Set<string>();
    for (const row of rows) {
      // `succeeded` + `stored` + 保存名の一致だけを残す（それ以外の行のファイルは中途として消す）
      if (storedFormatOf(row) && row.artifact) keep.add(row.artifact.path);
    }
    let removed = 0;
    for (const file of files) {
      if (keep.has(file)) continue;
      const id = trialArtifactIdOfFileName(file);
      // 保存後・終端更新前の窓に居るジョブ。行はまだ running で keep に入らない
      if (id !== undefined && this.#jobs.has(id)) continue;
      // 行の一覧を取った後にも確定は進むため、消す直前にその行だけ読み直す
      if (id !== undefined && this.#keepsStoredArtifact(id, file)) continue;
      try {
        await store.remove(file);
        removed += 1;
      } catch (error) {
        console.warn(`[u7agent] content trial artifact remove failed: ${this.#maskError(messageFor(error))}`);
      }
    }
    return removed;
  }

  /**
   * 消す直前にその行を読み直し、保存済みとして残すべき成果物かを確かめる。一覧を取ってから削除までの間にも
   * ジョブの確定は進むため、最後の判定は行ごとに行う。行を読めないときは消さない（安全側に倒す）。
   */
  #keepsStoredArtifact(id: string, fileName: string): boolean {
    try {
      const row = this.#db.readContentTrial(id);
      if (!row) return false;
      return storedFormatOf(row) !== undefined && row.artifact?.path === fileName;
    } catch (error) {
      console.warn(`[u7agent] content trial artifacts reconcile failed: ${this.#maskError(messageFor(error))}`);
      return true;
    }
  }

  /**
   * プロセスの close。実行中の試行を abort して `interrupted` にする。DB を書けない状態でも
   * プロセスは終わるので、失敗は警告だけにして待たない（起動時の再照合が同じ結果にする）。
   */
  async close(): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      if (job.terminal === null) {
        this.#settle(job, {
          state: "interrupted",
          failureCode: null,
          failureMessage: null,
          charged: false,
          artifact: null,
        });
      }
      job.controller.abort();
    }
    // provider の呼び出しが終わるまで待つのは close の責務ではない（abort で終わる）。取り残しは起動時に倒す
  }

  /** provider の 1 回の呼び出し。終端を決めた後に届いた結果は破棄する */
  async #run(job: RunningJob, target: TrialTarget): Promise<void> {
    try {
      if (target.kind === "speech") await this.#generateSpeechOnce(job, target);
      else await this.#generateImageOnce(job, target);
    } finally {
      // スロットと「実行中」の印の解放はここだけ。保存直後・終端更新の間もレジストリに残るため、
      // 一覧取得時の再照合が保存済みのファイルを中途ファイルとして消さない
      this.#jobs.delete(job.id);
    }
  }

  /** 失敗の終端。生成器の分類をそのまま写し、ユーザー中断だけ `canceled` にする */
  #settleFailure(job: RunningJob, code: ContentTrialFailureCode, message: string): void {
    this.#settle(job, {
      state: code === "aborted" ? "canceled" : "failed",
      failureCode: code,
      // 履歴に残る文言もマスカーを通す（provider の原文にキーが混じっても保存しない）
      failureMessage: this.#maskError(message),
      charged: false,
      artifact: null,
    });
  }

  /** 画像の provider を 1 回呼び、結果に応じて終端と成果物を確定する */
  async #generateImageOnce(job: RunningJob, target: TrialTarget): Promise<void> {
    const generate = this.#generateImage;
    if (!generate) return;
    let result: ImageGenerationResult;
    try {
      result = await generate({
        provider: target.provider,
        model: target.model,
        prompt: target.prompt,
        apiKey: target.apiKey,
        signal: job.controller.signal,
      });
    } catch (error) {
      // 生成器は例外を投げない契約だが、投げても試行を running のまま残さない
      result = { ok: false, code: "unknown", message: messageFor(error) };
    }
    if (job.terminal !== null) return;
    if (!result.ok) {
      this.#settleFailure(job, result.code, result.message);
      return;
    }
    // 生成は成功した（課金済み）。保存できなかった結果は成功として見せない
    const prepared = prepareTrialImageArtifact(result.image);
    if (!prepared.ok) {
      this.#settle(job, storageFailure(prepared.reason));
      return;
    }
    await this.#storeArtifact(job, {
      format: prepared.format,
      bytes: prepared.bytes,
      width: prepared.width,
      height: prepared.height,
    });
  }

  /** 音声の provider を 1 回呼ぶ。pcm は RIFF 化して wav として保存する */
  async #generateSpeechOnce(job: RunningJob, target: TrialTarget): Promise<void> {
    const generate = this.#generateSpeech;
    if (!generate) return;
    let result: SpeechGenerationResult;
    try {
      result = await generate({
        provider: target.provider,
        model: target.model,
        text: target.prompt,
        // 空は「送らない」（宣言が無いモデルの既定声に委ねる）
        ...(target.voice === null ? {} : { voice: target.voice }),
        ...(target.instructions === null ? {} : { instructions: target.instructions }),
        ...(target.speed === null ? {} : { speed: target.speed }),
        apiKey: target.apiKey,
        signal: job.controller.signal,
      });
    } catch (error) {
      result = { ok: false, code: "unknown", message: messageFor(error) };
    }
    if (job.terminal !== null) return;
    if (!result.ok) {
      this.#settleFailure(job, result.code, result.message);
      return;
    }
    const prepared = prepareTrialSpeechArtifact(result.speech);
    if (!prepared.ok) {
      this.#settle(job, storageFailure(prepared.reason));
      return;
    }
    // 音声に寸法は無い（履歴の行は形式とサイズだけを出す）
    await this.#storeArtifact(job, { format: prepared.format, bytes: prepared.bytes, width: null, height: null });
  }

  /** 成果物を書いて成功の終端を確定する。行とファイルの片側だけを残さない */
  async #storeArtifact(
    job: RunningJob,
    prepared: { format: TrialArtifactFormat; bytes: Uint8Array; width: number | null; height: number | null },
  ): Promise<void> {
    const store = this.#artifacts;
    if (!store) {
      // 置き場を用意できていない起動（永続化なし）。成功として見せない
      this.#settle(job, storageFailure("unavailable"));
      return;
    }
    const fileName = trialArtifactFileName(job.id, prepared.format);
    try {
      await store.write({ trialId: job.id, format: prepared.format, bytes: prepared.bytes });
    } catch (error) {
      console.warn(`[u7agent] content trial artifact write failed: ${this.#maskError(messageFor(error))}`);
      this.#settle(job, storageFailure("write"));
      return;
    }
    // 書き込みの間にキャンセルされたら確定させず、書いたファイルを捨てる
    if (job.terminal !== null) {
      await this.#discard(store, fileName);
      return;
    }
    const recorded = this.#settle(job, {
      state: "succeeded",
      failureCode: null,
      failureMessage: null,
      charged: true,
      artifact: {
        path: fileName,
        bytes: prepared.bytes.byteLength,
        format: prepared.format,
        width: prepared.width,
        height: prepared.height,
      },
    });
    // 終端を記録できていない成果物は残さない（行とファイルの片側だけを残さない）
    if (recorded) return;
    await this.#discard(store, fileName);
    // 記録できなかった成功を succeeded として見せず、メモリの終端も保存失敗に倒す
    // （DB が回復したら、この終端が次の取得で書き込まれる）
    this.#settle(job, storageFailure("write"));
  }

  async #discard(store: TrialArtifactStore, fileName: string): Promise<void> {
    try {
      await store.remove(fileName);
    } catch (error) {
      // 消せなくても、行が `running` のままなので起動時 / 一覧取得時の再照合が拾う
      console.warn(`[u7agent] content trial artifact remove failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  /** 終端を確定して DB へ書く。書けたかを返し、書けなくてもメモリの終端を保って後の取得で再試行する */
  #settle(job: RunningJob, decision: TerminalDecision): boolean {
    const finishedAt = this.#now();
    const row = this.#rowOf(job);
    const durationMs = finishedAt - row.startedAt;
    const recorded = this.#record(job.id, decision, finishedAt, durationMs);
    const memory: MemoryTerminal = {
      state: decision.state,
      failureCode: decision.failureCode,
      failureMessage: decision.failureMessage,
      charged: decision.charged,
      finishedAt,
      durationMs,
      recorded,
    };
    job.terminal = memory;
    if (recorded) this.#terminals.delete(job.id);
    else this.#terminals.set(job.id, memory);
    return recorded;
  }

  #record(id: string, decision: TerminalDecision, finishedAt: number, durationMs: number | null): boolean {
    try {
      this.#db.finishContentTrial({
        id,
        state: decision.state,
        failureCode: decision.failureCode,
        failureMessage: decision.failureMessage,
        finishedAt,
        durationMs,
        charged: decision.charged,
        artifact: decision.artifact,
      });
      return true;
    } catch (error) {
      console.warn(`[u7agent] content trial finish failed: ${this.#maskError(messageFor(error))}`);
      return false;
    }
  }

  /** 記録できなかった終端を、後の取得で書き直す（DB が回復したら再起動なしで収束させる） */
  #retryUnrecorded(): void {
    for (const [id, terminal] of this.#terminals) {
      const recorded = this.#record(
        id,
        {
          state: terminal.state,
          failureCode: terminal.failureCode,
          failureMessage: terminal.failureMessage,
          charged: terminal.charged,
          // 記録できなかった成果物は残さないため、再試行でも成果物なしとして書く
          artifact: null,
        },
        terminal.finishedAt,
        terminal.durationMs,
      );
      if (recorded) this.#terminals.delete(id);
    }
  }

  /** 同じ入力の保存済み成功。置き場のパスが行と一致しない行は再利用しない（配信できないため） */
  #reusable(input: {
    kind: string;
    model: string;
    prompt: string;
    voice: string | null;
    instructions: string | null;
    speed: number | null;
  }): ContentTrialRow | undefined {
    try {
      const row = this.#db.findReusableContentTrial(input);
      if (!row) return undefined;
      return storedFormatOf(row) ? row : undefined;
    } catch (error) {
      console.warn(`[u7agent] content trial reuse lookup failed: ${this.#maskError(messageFor(error))}`);
      return undefined;
    }
  }

  #usage(): ContentTrialArtifactUsage {
    try {
      return this.#db.readContentTrialArtifactUsage();
    } catch (error) {
      console.warn(`[u7agent] content trial usage failed: ${this.#maskError(messageFor(error))}`);
      return EMPTY_USAGE;
    }
  }

  /**
   * `running` の取り残しを `interrupted` に倒し、置き場を再照合する。レジストリに居るジョブと、
   * 期限 + 余裕を過ぎていない行は触らない（一覧の取得が正常なジョブを中断しない）。DB の失敗は握って一覧は返す。
   */
  #reconcileIfDue(): void {
    const now = this.#now();
    if (now - this.#lastReconcileAt < RECONCILE_INTERVAL_MS) return;
    this.#lastReconcileAt = now;
    let rows: ContentTrialRow[];
    try {
      rows = this.#db.listContentTrials().filter((row) => row.state === "running");
    } catch (error) {
      console.warn(`[u7agent] content trials reconcile failed: ${this.#maskError(messageFor(error))}`);
      return;
    }
    for (const row of rows) {
      if (this.#jobs.has(row.id)) continue;
      if (now < row.startedAt + this.#timeoutOf(row.kind) + RECONCILE_MARGIN_MS) continue;
      this.#interrupt(row);
    }
    // 一覧の応答は同期的に返すため、置き場の掃除は待たない（多重起動しない）
    if (!this.#sweeping) {
      this.#sweeping = true;
      void this.reconcileArtifacts().finally(() => {
        this.#sweeping = false;
      });
    }
  }

  #interrupt(row: ContentTrialRow): void {
    try {
      this.#db.finishContentTrial({
        id: row.id,
        state: "interrupted",
        failureCode: null,
        failureMessage: null,
        finishedAt: this.#now(),
        // 実際の終了時刻は分からないため、所要時間は記録しない（起動時の再照合と同じ扱い）
        durationMs: null,
        charged: row.charged,
        artifact: null,
      });
    } catch (error) {
      console.warn(`[u7agent] content trial interrupt failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  /** ジョブの行。DB を読めない経路（キャンセル直後の応答）で使う最小の復元 */
  #rowOf(job: RunningJob): ContentTrialRow {
    const row = {
      id: job.id,
      kind: job.kind,
      model: "",
      prompt: "",
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
      startedAt: this.#now(),
      finishedAt: null,
      durationMs: null,
    } satisfies ContentTrialRow;
    try {
      return this.#db.readContentTrial(job.id) ?? row;
    } catch {
      return row;
    }
  }

  /** DB の行とメモリの終端を重ねる。記録できていない終端はメモリ側を採用する */
  #view(row: ContentTrialRow): ContentTrialView {
    const terminal = this.#terminals.get(row.id) ?? this.#jobs.get(row.id)?.terminal ?? null;
    const format = isTrialId(row.id) ? storedFormatOf(row) : undefined;
    const base: ContentTrialView = {
      id: row.id,
      kind: isTrialKind(row.kind) ? row.kind : "image",
      model: row.model,
      prompt: row.prompt,
      voice: row.voice,
      instructions: row.instructions,
      speed: row.speed,
      state: isTrialState(row.state) ? row.state : "failed",
      keyEpoch: row.keyEpoch,
      artifactState: format ? "stored" : "none",
      artifact:
        format && row.artifact
          ? { format, bytes: row.artifact.bytes, width: row.artifact.width, height: row.artifact.height }
          : null,
      charged: row.charged,
      failureCode: isFailureCode(row.failureCode) ? row.failureCode : null,
      failureMessage: row.failureMessage,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      recorded: true,
    };
    // DB が終端を記録済みならその値が正。記録できていない間だけメモリの終端を重ねる
    if (!terminal || base.state !== "running") return base;
    return {
      ...base,
      state: terminal.state,
      // 記録できていない成果物は残さないため、メモリ側の終端は常に「記録のみ」
      artifactState: "none",
      artifact: null,
      charged: terminal.charged,
      failureCode: terminal.failureCode,
      failureMessage: terminal.failureMessage,
      finishedAt: terminal.finishedAt,
      durationMs: terminal.durationMs,
      recorded: false,
    };
  }
}

/** 保存済みとして配信できる形式。`succeeded` + `stored` + 種別の許可リスト + 保存名の一致だけを通す */
function storedFormatOf(row: ContentTrialRow): TrialArtifactFormat | undefined {
  if (row.state !== "succeeded" || row.artifactState !== "stored" || !row.artifact) return undefined;
  if (!isTrialId(row.id)) return undefined;
  const format = trialArtifactFormatOf(row.artifact.format);
  if (!format) return undefined;
  // 画像の行に音声、音声の行に画像を配信しない
  if (!trialArtifactFormatAllowed(row.kind, format)) return undefined;
  return row.artifact.path === trialArtifactFileName(row.id, format) ? format : undefined;
}

/** 成果物を残せなかった成功。分類は `storage`、課金済みとして記録する */
type StorageFailureReason = TrialArtifactRejectReason | "unavailable" | "write";

function storageFailure(reason: StorageFailureReason): TerminalDecision {
  const failureMessage =
    reason === "too_large"
      ? CONTENT_TRIAL_ARTIFACT_TOO_LARGE_MESSAGE
      : reason === "unsupported_format" || reason === "invalid_bytes"
        ? CONTENT_TRIAL_ARTIFACT_FORMAT_MESSAGE
        : CONTENT_TRIAL_STORAGE_FAILED_MESSAGE;
  return { state: "failed", failureCode: "storage", failureMessage, charged: true, artifact: null };
}

/**
 * 種別ごとの入力スナップショット。音声は本文に加えてボイス・演技指示・話速を課金前に検査し、
 * 空の音声パラメーターは null（送らない）へ寄せる。
 */
function trialParametersOf(
  kind: ContentTrialKind,
  input: { voice?: string | undefined; instructions?: string | undefined; speed?: number | undefined },
): { voice: string | null; instructions: string | null; speed: number | null } | { error: string } {
  if (kind !== "speech") {
    if (input.voice !== undefined || input.instructions !== undefined || input.speed !== undefined) {
      return { error: CONTENT_TRIAL_SPEECH_PARAMS_MESSAGE };
    }
    return { voice: null, instructions: null, speed: null };
  }
  const voice = (input.voice ?? "").trim();
  const instructions = input.instructions ?? "";
  if (instructions.length > CONTENT_TRIAL_INSTRUCTIONS_MAX_LENGTH) {
    return { error: CONTENT_TRIAL_SPEECH_INSTRUCTIONS_TOO_LONG_MESSAGE };
  }
  // 範囲（Seed Audio の 0.5–2.0 など）は provider の制約なのでここでは縛らない
  if (input.speed !== undefined && !(Number.isFinite(input.speed) && input.speed > 0)) {
    return { error: CONTENT_TRIAL_SPEECH_SPEED_MESSAGE };
  }
  return {
    voice: voice === "" ? null : voice,
    instructions: instructions.trim() === "" ? null : instructions,
    speed: input.speed === undefined ? null : input.speed,
  };
}

/**
 * 生成器へ渡す provider と model。画像はカタログの `provider/id` を分け、音声は provider を固定する
 * （音声のモデル id はそれ自体が `owner/model` の形で、アプリの provider 名とは別）。
 */
function generationRouteOf(kind: ContentTrialKind, model: string): { provider: string; model: string } | null {
  if (kind === "speech") return model === "" ? null : { provider: SPEECH_PROVIDER_ID, model };
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return null;
  return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
}

function isTrialKind(value: string): value is ContentTrialKind {
  return (CONTENT_TRIAL_KINDS as readonly string[]).includes(value);
}

function isTrialState(value: string): value is ContentTrialState {
  return (CONTENT_TRIAL_STATES as readonly string[]).includes(value);
}

function isFailureCode(value: string | null): value is ContentTrialFailureCode {
  return value !== null && (CONTENT_TRIAL_FAILURE_CODES as readonly string[]).includes(value);
}

/** 不透明な ID。パスやユーザー入力から作らない（配信ルートは id だけを受ける） */
function newTrialId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `trial-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
