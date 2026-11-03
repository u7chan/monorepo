/**
 * 設定 → コンテンツ生成の試行ジョブ。画面の寿命に縛られず、リクエストの `AbortSignal` にも結び付けない
 * （明示キャンセルとプロセスの close だけが中断する）。状態はメモリのレジストリとアプリ DB の
 * `content_trials` の両方で持ち、再起動でレジストリを失った `running` は `interrupted` に倒す。
 * 成果物は段階 1 では持たず、`artifactState` は常に `none`（契約は docs/api-settings.md）。
 */
import { messageFor } from "./http";
import { CONTENT_DISABLED_MESSAGE } from "./content-disabled";
import { IMAGE_GENERATION_TIMEOUT_MS, type ImageGenerationInput, type ImageGenerationResult } from "./images";
import type { ContentTrialRow } from "./app-db";
import type { ProviderFailureCode } from "./provider-failure";

/** 試行の種別。段階 1 は画像だけで、音声 / BGM は後の段階で足す */
export const CONTENT_TRIAL_KINDS = ["image"] as const;
export type ContentTrialKind = (typeof CONTENT_TRIAL_KINDS)[number];

/** 終端状態は不変で、`running` からしか遷移しない */
export const CONTENT_TRIAL_STATES = ["running", "succeeded", "failed", "canceled", "interrupted"] as const;
export type ContentTrialState = (typeof CONTENT_TRIAL_STATES)[number];

/** 成果物の状態。段階 2 で `stored` を足す（段階 1 は保存しない） */
export const CONTENT_TRIAL_ARTIFACT_STATES = ["none"] as const;
export type ContentTrialArtifactState = (typeof CONTENT_TRIAL_ARTIFACT_STATES)[number];

/** プロンプトの上限。provider の上限ではなく、履歴に残す本文としての歯止め */
export const CONTENT_TRIAL_PROMPT_MAX_LENGTH = 4_000;

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

/**
 * `running` のまま残った行を一覧取得時に再照合する条件。provider の期限に余裕を足した時刻を過ぎ、
 * かつレジストリにも居ない行だけを倒す（生きているジョブを一覧の取得で中断しない）。
 */
const RECONCILE_MARGIN_MS = 30_000;
/** 一覧の取得ごとに DB を書き換えないための間引き */
const RECONCILE_INTERVAL_MS = 5_000;

/** 試行 1 件の応答形 */
export interface ContentTrialView {
  id: string;
  kind: ContentTrialKind;
  /** 送信時のモデル (`provider/id`)。現在の保存値とは混ぜない */
  model: string;
  prompt: string;
  state: ContentTrialState;
  keyEpoch: number;
  artifactState: ContentTrialArtifactState;
  failureCode: ProviderFailureCode | null;
  failureMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  /** 終端状態を DB へ記録できたか。false の間はメモリの状態を優先して返す */
  recorded: boolean;
}

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
  }): boolean;
  readContentTrial(id: string): ContentTrialRow | undefined;
  listContentTrials(kind?: string): ContentTrialRow[];
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
}

export interface ContentTrialsOptions {
  db: ContentTrialsDb;
  source: ContentTrialSource;
  /** 画像の生成器（PiBff が持つ）。未注入（ランタイムなしで起動）は runtime 不可と同じ 503 */
  generateImage?: ((input: ImageGenerationInput) => Promise<ImageGenerationResult>) | undefined;
  /** ログ・状態へ出す前の文言境界 */
  maskError: (text: string) => string;
  /** 時計。テストで進める */
  now?: () => number;
}

export type ContentTrialStartOutcome =
  | { status: 202; trial: ContentTrialView }
  | { status: 400 | 409 | 503; error: string };

export type ContentTrialReadOutcome = { status: 200; trial: ContentTrialView } | { status: 404; error: string };

export type ContentTrialListOutcome = {
  status: 200;
  items: ContentTrialView[];
  keyEpoch: number;
};

export type ContentTrialRemoveOutcome =
  | { status: 200; removed: number }
  | { status: 404; error: string }
  | { status: 409; error: string };

/** メモリ上の終端状態。DB へ書けなかった間も GET / 一覧はここを優先して返す */
interface MemoryTerminal {
  state: Exclude<ContentTrialState, "running">;
  failureCode: ProviderFailureCode | null;
  failureMessage: string | null;
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

export class ContentTrialsService {
  #db: ContentTrialsDb;
  #source: ContentTrialSource;
  #generateImage: ((input: ImageGenerationInput) => Promise<ImageGenerationResult>) | undefined;
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

  constructor(options: ContentTrialsOptions) {
    this.#db = options.db;
    this.#source = options.source;
    this.#generateImage = options.generateImage;
    this.#maskError = options.maskError;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 起動時の再照合。レジストリは空なので、`running` の行はすべて前のプロセスの取り残しとして
   * `interrupted` に倒す（再開はしない）。
   */
  async applyStored(): Promise<void> {
    try {
      const interrupted = this.#db.interruptRunningContentTrials(this.#now());
      if (interrupted > 0) console.warn(`[u7agent] content trials interrupted on startup: ${interrupted}`);
    } catch (error) {
      // 倒せなくても起動は続ける。一覧の取得時の再照合と、次の起動で同じ結果になる
      console.warn(`[u7agent] content trials reconcile failed: ${this.#maskError(messageFor(error))}`);
    }
  }

  /** 種別の実行中ジョブ。終端を決めた後も provider の呼び出しが終わるまで数える（スロットを解放しない） */
  running(kind: ContentTrialKind): boolean {
    for (const job of this.#jobs.values()) {
      if (job.kind === kind) return true;
    }
    return false;
  }

  /** 試行の開始。応答は開始直後（202）で、状態は GET で取る */
  start(input: { kind: string; model: string; prompt: string }): ContentTrialStartOutcome {
    if (!isTrialKind(input.kind)) return { status: 400, error: CONTENT_TRIAL_KIND_UNSUPPORTED_MESSAGE };
    if (!this.#generateImage) return { status: 503, error: CONTENT_TRIAL_RUNTIME_UNAVAILABLE_MESSAGE };
    const prompt = input.prompt;
    if (prompt.trim() === "") return { status: 400, error: CONTENT_TRIAL_PROMPT_EMPTY_MESSAGE };
    if (prompt.length > CONTENT_TRIAL_PROMPT_MAX_LENGTH)
      return { status: 400, error: CONTENT_TRIAL_PROMPT_TOO_LONG_MESSAGE };
    if (this.running(input.kind)) return { status: 409, error: CONTENT_TRIAL_ALREADY_RUNNING_MESSAGE };
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
    if (!this.#source.models().includes(input.model)) {
      return { status: 400, error: `${CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE}: ${input.model}` };
    }
    const provider = input.model.slice(0, input.model.indexOf("/"));
    const model = input.model.slice(input.model.indexOf("/") + 1);
    if (provider === "" || model === "") {
      return { status: 400, error: `${CONTENT_TRIAL_MODEL_NOT_IN_CATALOG_MESSAGE}: ${input.model}` };
    }

    const startedAt = this.#now();
    const row: ContentTrialRow = {
      id: newTrialId(),
      kind: input.kind,
      model: input.model,
      prompt,
      state: "running",
      keyEpoch: this.#db.readContentKeyEpoch(),
      artifactState: "none",
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
    const job: RunningJob = { id: row.id, kind: input.kind, controller: new AbortController(), terminal: null };
    this.#jobs.set(row.id, job);
    // 応答は開始直後（202）に返し、ジョブの完了は待たない
    void this.#run(job, { provider, model, prompt, apiKey: snapshot.apiKey });
    return { status: 202, trial: this.#view(row) };
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

  /** 一覧。取得のたびに（間引いて）`running` の取り残しを再照合し、DB 回復後は終端の記録を再試行する */
  list(kind?: string): ContentTrialListOutcome {
    this.#reconcileIfDue();
    this.#retryUnrecorded();
    const rows = this.#db.listContentTrials(kind);
    return { status: 200, items: rows.map((row) => this.#view(row)), keyEpoch: this.#db.readContentKeyEpoch() };
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
      this.#settle(job, { state: "canceled", failureCode: "aborted", failureMessage: null });
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

  /** 個別削除。終端状態だけを受け付け、`running` は 409（先に中断してもらう） */
  remove(id: string): ContentTrialRemoveOutcome {
    let row: ContentTrialRow | undefined;
    try {
      row = this.#db.readContentTrial(id);
    } catch (error) {
      console.warn(`[u7agent] content trial read failed: ${this.#maskError(messageFor(error))}`);
      throw error;
    }
    if (!row) return { status: 404, error: CONTENT_TRIAL_NOT_FOUND_MESSAGE };
    if (row.state === "running") return { status: 409, error: CONTENT_TRIAL_DELETE_RUNNING_MESSAGE };
    return { status: 200, removed: this.#db.deleteContentTrial(id) ? 1 : 0 };
  }

  /** 全削除。`running` は対象にしない（終端状態だけを消す） */
  removeAll(kind?: string): { status: 200; removed: number } {
    return { status: 200, removed: this.#db.deleteTerminalContentTrials(kind) };
  }

  /**
   * プロセスの close。実行中の試行を abort して `interrupted` にする。DB を書けない状態でも
   * プロセスは終わるので、失敗は警告だけにして待たない（起動時の再照合が同じ結果にする）。
   */
  async close(): Promise<void> {
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) {
      if (job.terminal === null) this.#settle(job, { state: "interrupted", failureCode: null, failureMessage: null });
      job.controller.abort();
    }
    // provider の呼び出しが終わるまで待つのは close の責務ではない（abort で終わる）。取り残しは起動時に倒す
  }

  /** provider の 1 回の呼び出し。終端を決めた後に届いた結果は破棄する */
  async #run(
    job: RunningJob,
    input: { provider: string; model: string; prompt: string; apiKey: string },
  ): Promise<void> {
    const generate = this.#generateImage;
    if (!generate) return;
    let result: ImageGenerationResult;
    try {
      result = await generate({
        provider: input.provider,
        model: input.model,
        prompt: input.prompt,
        apiKey: input.apiKey,
        signal: job.controller.signal,
      });
    } catch (error) {
      // 生成器は例外を投げない契約だが、投げても試行を running のまま残さない
      result = { ok: false, code: "unknown", message: this.#maskError(messageFor(error)) };
    } finally {
      // スロットの解放はここだけ（キャンセル済みでも provider の呼び出しが終わるまで解放しない）
      this.#jobs.delete(job.id);
    }
    if (job.terminal !== null) return;
    if (result.ok) {
      this.#settle(job, { state: "succeeded", failureCode: null, failureMessage: null });
      return;
    }
    this.#settle(job, {
      state: result.code === "aborted" ? "canceled" : "failed",
      failureCode: result.code,
      // 履歴に残る文言もマスカーを通す（provider の原文にキーが混じっても保存しない）
      failureMessage: this.#maskError(result.message),
    });
  }

  /** 終端を確定して DB へ書く。書けなくてもメモリの終端を保ち、後の GET / 一覧で記録を再試行する */
  #settle(
    job: RunningJob,
    terminal: {
      state: Exclude<ContentTrialState, "running">;
      failureCode: ProviderFailureCode | null;
      failureMessage: string | null;
    },
  ): void {
    const finishedAt = this.#now();
    const row = this.#rowOf(job);
    const durationMs = finishedAt - row.startedAt;
    const recorded = this.#record(job.id, terminal, finishedAt, durationMs);
    const memory = { ...terminal, finishedAt, durationMs, recorded };
    job.terminal = memory;
    if (recorded) this.#terminals.delete(job.id);
    else this.#terminals.set(job.id, memory);
  }

  #record(
    id: string,
    terminal: {
      state: Exclude<ContentTrialState, "running">;
      failureCode: ProviderFailureCode | null;
      failureMessage: string | null;
    },
    finishedAt: number,
    durationMs: number | null,
  ): boolean {
    try {
      this.#db.finishContentTrial({
        id,
        state: terminal.state,
        failureCode: terminal.failureCode,
        failureMessage: terminal.failureMessage,
        finishedAt,
        durationMs,
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
        { state: terminal.state, failureCode: terminal.failureCode, failureMessage: terminal.failureMessage },
        terminal.finishedAt,
        terminal.durationMs,
      );
      if (recorded) this.#terminals.delete(id);
    }
  }

  /**
   * `running` の取り残しを `interrupted` に倒す。レジストリに居るジョブと、期限 + 余裕を過ぎていない行は
   * 触らない（一覧の取得が正常なジョブを中断しない）。DB の失敗は握って一覧は返す。
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
      if (now < row.startedAt + IMAGE_GENERATION_TIMEOUT_MS + RECONCILE_MARGIN_MS) continue;
      this.#interrupt(row);
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
      state: "running",
      keyEpoch: 0,
      artifactState: "none",
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
    const base: ContentTrialView = {
      id: row.id,
      kind: isTrialKind(row.kind) ? row.kind : "image",
      model: row.model,
      prompt: row.prompt,
      state: isTrialState(row.state) ? row.state : "failed",
      keyEpoch: row.keyEpoch,
      artifactState: isArtifactState(row.artifactState) ? row.artifactState : "none",
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
      failureCode: terminal.failureCode,
      failureMessage: terminal.failureMessage,
      finishedAt: terminal.finishedAt,
      durationMs: terminal.durationMs,
      recorded: false,
    };
  }
}

function isTrialKind(value: string): value is ContentTrialKind {
  return (CONTENT_TRIAL_KINDS as readonly string[]).includes(value);
}

function isTrialState(value: string): value is ContentTrialState {
  return (CONTENT_TRIAL_STATES as readonly string[]).includes(value);
}

function isArtifactState(value: string): value is ContentTrialArtifactState {
  return (CONTENT_TRIAL_ARTIFACT_STATES as readonly string[]).includes(value);
}

const FAILURE_CODES: readonly string[] = [
  "invalid_key",
  "insufficient_credit",
  "rate_limited",
  "timeout",
  "aborted",
  "unknown",
];

function isFailureCode(value: string | null): value is ProviderFailureCode {
  return value !== null && FAILURE_CODES.includes(value);
}

/** 不透明な ID。パスやユーザー入力から作らない（配信ルートは id だけを受ける） */
function newTrialId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `trial-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
