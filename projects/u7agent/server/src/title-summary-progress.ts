/**
 * 会話タイトルの AI 要約の進行 (自動 / 手動の受付、見送りの判定、順番待ち、適用、使用量の記録、取消)。
 * 会話のランとは独立した状態機械なので、SessionStore のライフサイクルとは分けてこの 1 か所に閉じる。
 * record (titleOrigin / titleAttempt / titleTask) の所有は会話ストアに残し、「まだ現役か」「保存」
 * 「resync の配信」「マスク」だけを port から受け取る。
 */
import { randomBytes } from "node:crypto";
import { httpError, messageFor } from "./errors";
import { modelLabel } from "./model-ref";
import type { RunState, SessionRecord } from "./session-record";
import type { SecretMasker } from "./redact";
import type { ThinkingLevel } from "./schema";
import {
  settledTitleAttemptOf,
  autoTitleSkipReason,
  titleApplyBlockedReason,
  titleRequestOf,
  titleSummaryOf,
  TITLE_ATTEMPT_ERROR_MAX,
} from "./session-title";
import type { SessionTitleSummary, TitleAttempt } from "./session-title";
import { contentText, truncate } from "./session-projection";
import { writeSessionMeta, type SessionMeta } from "./session-store";
import type { TitleSummaryHost, TitleSummaryResult, TitleSummaryUsage } from "./title-summary";
import type { TitleSummaryQueue, TitleSummaryQueueResult } from "./title-summary-queue";

/** 進行が会話ストアへ要求する口。private を公開せずに切り出すための境界 */
export interface TitleSummaryProgressPort {
  /** 秘密値のマスク。外部へ出す入力と、保存する失敗理由の両方に使う */
  readonly masker: SecretMasker;
  /** 削除済み・別世代に差し替わった record は触らない (適用も resync もしない) */
  isLive(record: SessionRecord): boolean;
  /** 操作を受け付けられる状態か。閉鎖中は 503、履歴クリア中などは 409 を投げる */
  assertLive(record: SessionRecord): void;
  /** 会話の実行中・圧縮中。手動の再要約を受け付けない条件 */
  isBusy(record: SessionRecord): boolean;
  /** 実行が継続中か (開始送信の準備中と、終端処理が済む前の SDK idle も含む) */
  isRunning(record: SessionRecord): boolean;
  /** meta だけを保存する (履歴が変わっていない呼び出し用) */
  persist(record: SessionRecord): Promise<string | undefined>;
  /** 一覧と開いている画面の状態表示を作り直す */
  resync(record: SessionRecord): void;
  /** 予約時点の設定と 1 回の生成。null は要約しない */
  host(): TitleSummaryHost | null;
  /** 補助呼び出しの共有枠 (同時実行数・待ち期限) */
  queue(): TitleSummaryQueue;
  /** 保存先。null は永続化なし (メモリのみ) */
  storeDir(): string | null;
  /** 未ロードの一覧の射影。起動時の復旧で、保存し直した meta を反映する */
  descriptors(): Map<string, SessionMeta>;
}

/** 要約の進行。呼ぶかどうかの判断と試行の記録はここが持ち、生成そのものは host に任せる */
export class TitleSummaryProgress {
  constructor(private readonly port: TitleSummaryProgressPort) {}

  /**
   * 前のプロセスが予約 (pending) のまま落ちた試行を、起動時に interrupted として保存し直す。
   * 未ロードの一覧だけを見ても「実行中」が残らないようにする (summaryOfMeta の投影と二重の防御)。
   */
  async recoverInterruptedAttempts(): Promise<void> {
    const storeDir = this.port.storeDir();
    if (!storeDir) return;
    for (const [id, meta] of this.port.descriptors()) {
      if (meta.titleAttempt?.state !== "pending") continue;
      const settled = settledTitleAttemptOf(meta.titleAttempt);
      if (!settled) continue;
      const updated = { ...meta, titleAttempt: settled };
      this.port.descriptors().set(id, updated);
      try {
        await writeSessionMeta(storeDir, updated);
      } catch (error) {
        console.warn(
          `[u7agent] 中断したタイトル試行の保存に失敗しました (${id}): ${this.port.masker.mask(messageFor(error))}`,
        );
      }
    }
  }

  /**
   * 判定点 (初めて本文を伴う正常完了が得られたランの直後) で AI 要約を 1 回だけ予約する。
   * Off・モデル不在・手動改名・依頼本文なしでも判定を残し、後続のターンや設定変更で再走査しない。
   * 予約は外部呼び出しより先に保存し、保存できないときは生成を始めない (再起動・複数タブ・
   * クラッシュで重複実行しないための前提)。
   */
  async summarize(record: SessionRecord, run: RunState, assistantText: string | undefined): Promise<void> {
    const host = this.port.host();
    if (!host || record.titleAttempt) return;
    if (run.status !== "completed") return;
    const response = assistantText?.trim();
    if (!response) return;
    const settings = host.settings();
    const request = record.titleRequest ?? record.title;
    const skipReason = autoTitleSkipReason({ titleOrigin: record.titleOrigin, request }, settings);
    const model = modelLabel(settings.model);
    const thinkingLevel = settings.thinkingLevel;
    const attempt: TitleAttempt = {
      runId: run.id,
      at: Date.now(),
      state: skipReason ? "skipped" : "pending",
      trigger: "auto",
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      generation: settings.generation,
      ...(skipReason ? { skipReason } : {}),
    };
    record.titleAttempt = attempt;
    if (skipReason || !settings.model) {
      await this.port.persist(record);
      if (this.port.isLive(record)) this.port.resync(record);
      return;
    }
    await this.runTitleSummary(record, {
      attempt,
      trigger: "auto",
      model: settings.model,
      thinkingLevel,
      definition: settings.definition,
      request,
      response,
      generation: settings.generation,
      shouldStart: (task) =>
        this.port.isLive(record) &&
        !record.clearingHistory &&
        record.titleTask === task &&
        record.run?.id === run.id &&
        record.run?.status === "completed" &&
        !record.compacting,
    });
  }

  /**
   * 会話メニューからの明示的な再要約。1 会話 1 回の自動要約とは別に、利用者の操作で何度でも実行できる。
   * 生成を待ってから現在のタイトルと試行を返す (呼び出し側は失敗理由をそのまま画面へ出せる)。
   * 実行中・圧縮中・別の要約の実行中は受け付けない。
   */
  async summarizeManually(record: SessionRecord): Promise<{ title: string; titleSummary: SessionTitleSummary }> {
    this.port.assertLive(record);
    const host = this.port.host();
    if (!host) throw httpError(503, "AI要約を利用できません");
    if (this.port.isBusy(record)) throw httpError(409, "会話の実行中は再要約できません");
    if (record.titleTask) throw httpError(409, "AI要約を実行中です");
    const settings = host.settings();
    if (!settings.enabled) throw httpError(409, "AI要約は Off です");
    const model = settings.model;
    if (!model) throw httpError(409, "要約モデルが選択されていません");
    const request = this.manualTitleRequest(record);
    if (!request) throw httpError(409, "依頼本文がないため再要約できません");
    const response = this.manualTitleResponse(record);
    if (!response) throw httpError(409, "要約できる応答がありません");
    const attempt: TitleAttempt = {
      runId: `manual-${randomBytes(8).toString("hex")}`,
      at: Date.now(),
      state: "pending",
      trigger: "manual",
      ...(modelLabel(model) ? { model: modelLabel(model) } : {}),
      ...(settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {}),
      generation: settings.generation,
    };
    await this.runTitleSummary(record, {
      attempt,
      trigger: "manual",
      model,
      thinkingLevel: settings.thinkingLevel,
      definition: settings.definition,
      request,
      response,
      generation: settings.generation,
      shouldStart: (task) =>
        this.port.isLive(record) &&
        !record.clearingHistory &&
        record.titleTask === task &&
        !this.port.isRunning(record) &&
        record.queue.length === 0 &&
        !record.compacting,
    });
    // 終端の保存は settle が非同期に始める。応答を見た直後の一覧が古いタイトルを返さないよう、
    // 同じ record の保存列 (persistTail) の最後まで待ってから返す
    await this.port.persist(record);
    return {
      title: record.title,
      titleSummary: titleSummaryOf({ origin: record.titleOrigin, attempt: record.titleAttempt }, this.port.masker),
    };
  }

  /**
   * 再要約の依頼本文。新形式は送信時に保存した先頭を使い、保存前の会話 (旧 meta) だけ最初の
   * user メッセージから作る。定型プロンプトが混ざり得るが、再要約を不能にしない方を選ぶ。
   */
  private manualTitleRequest(record: SessionRecord): string {
    const stored = record.titleRequest?.trim();
    if (stored) return stored;
    const firstUser = record.session.messages.find((message) => message.role === "user");
    if (!firstUser) return "";
    const raw = contentText(firstUser.content).trim();
    return raw ? this.port.masker.mask(titleRequestOf(raw)).trim() : "";
  }

  /** 再要約の応答。最後の完了した assistant テキストだけを使い、エラー / 中断の応答は対象外にする */
  private manualTitleResponse(record: SessionRecord): string {
    const messages = record.session.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const text = this.port.masker.mask(contentText(message.content)).trim();
      if (text) return text;
    }
    return "";
  }

  /**
   * 予約の保存 → 設定の再確認 → 順番待ち → 生成 → 適用。自動 / 手動の違いは入力と shouldStart だけ。
   * 予約 (pending) と終端 (done / failed / skipped) の両方で resync を配り、一覧と開いている画面の
   * 状態表示を診断を開かなくても追従させる。
   */
  private async runTitleSummary(
    record: SessionRecord,
    input: {
      attempt: TitleAttempt;
      trigger: "auto" | "manual";
      model: { provider: string; id: string };
      thinkingLevel?: ThinkingLevel;
      definition: string;
      request: string;
      response: string;
      generation: number;
      shouldStart: (task: NonNullable<SessionRecord["titleTask"]>) => boolean;
    },
  ): Promise<void> {
    const host = this.port.host();
    if (!host || record.clearingHistory) return;
    const model = modelLabel(input.model);
    const abort = new AbortController();
    const task = { runId: input.attempt.runId, generation: input.generation, model, abort };
    record.titleAttempt = input.attempt;
    record.titleTask = task;
    const failure = await this.port.persist(record);
    if (failure) {
      // 予約が保存できていない状態で送ると、クラッシュ後に試行済みかを復元できない
      if (record.titleTask === task) delete record.titleTask;
      this.settleTitleAttempt(record, task, {
        state: "failed",
        error: truncate(this.port.masker.mask(failure), TITLE_ATTEMPT_ERROR_MAX),
      });
      return;
    }
    if (this.port.isLive(record)) this.port.resync(record);
    // 保存を待つ間に取り消された (Off / 手動改名 / 停止)。結果の適用だけでなく開始も止める
    if (record.titleTask !== task) return;
    const current = host.settings();
    const blocked = titleApplyBlockedReason(
      { titleOrigin: record.titleOrigin, trigger: input.trigger, generation: input.generation, model },
      current,
    );
    if (blocked) {
      delete record.titleTask;
      this.settleTitleAttempt(record, task, { state: "skipped", skipReason: blocked });
      return;
    }
    const startedAt = Date.now();
    let queued: TitleSummaryQueueResult<TitleSummaryResult>;
    try {
      queued = await this.port.queue().run(
        {
          signal: abort.signal,
          // 順番待ちの間に本会話が動き出したら (新しい実行・圧縮)、本会話を優先して捨てる。
          // SDK の isStreaming は終端直後にまだ true のことがあるため、判定は run の同一性で行う
          shouldStart: () => this.port.isLive(record) && record.titleTask === task && input.shouldStart(task),
        },
        () =>
          host.generate({
            model: input.model,
            definition: input.definition,
            request: input.request,
            response: input.response,
            sessionId: record.session.sessionId,
            thinkingLevel: input.thinkingLevel,
            signal: abort.signal,
          }),
      );
    } catch (error) {
      // 補助呼び出しの想定外の失敗はタイトルを変えず、試行だけ消費する (自動再試行しない)
      if (record.titleTask === task) delete record.titleTask;
      this.settleTitleAttempt(record, task, {
        state: "failed",
        error: truncate(this.port.masker.mask(messageFor(error)), TITLE_ATTEMPT_ERROR_MAX),
      });
      return;
    }
    if (queued.kind === "skipped") {
      if (record.titleTask !== task) return;
      delete record.titleTask;
      this.settleTitleAttempt(record, task, {
        state: "skipped",
        skipReason: queued.reason === "cancelled" ? "cancelled" : "not-ready",
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    this.applyTitleSummary(record, task, queued.value, Date.now() - startedAt);
  }

  /**
   * 生成結果の適用。予約後にタイトルが手動で変えられた / 設定が変わった / 取り消された結果は捨てる。
   * usage は採用できたかと独立に残す。
   */
  private applyTitleSummary(
    record: SessionRecord,
    task: { runId: string; generation: number; model: string | undefined },
    result: TitleSummaryResult,
    durationMs: number,
  ): void {
    if (record.clearingHistory) return;
    const running = record.titleTask;
    if (running === undefined) {
      // 取消後に届いた結果はタイトルへ適用しないが、送信済みの要求の usage は試行へ残す
      this.recordTitleAttemptUsage(record, task, result.usage);
      return;
    }
    if (running.runId !== task.runId) return;
    delete record.titleTask;
    if (!result.ok) {
      this.settleTitleAttempt(record, task, {
        state: "failed",
        error: result.error,
        durationMs,
        ...usageFields(result.usage),
      });
      return;
    }
    const current = this.port.host()?.settings();
    const blocked = titleApplyBlockedReason(
      {
        titleOrigin: record.titleOrigin,
        trigger: record.titleAttempt?.trigger,
        generation: task.generation,
        model: task.model,
      },
      current,
    );
    if (blocked) {
      this.settleTitleAttempt(record, task, {
        state: "skipped",
        skipReason: blocked,
        durationMs,
        ...usageFields(result.usage),
      });
      return;
    }
    record.title = result.title;
    record.titleOrigin = "ai";
    // settle が meta の保存と resync を行う (タイトルの変更も一覧と開いている画面へ届く)
    this.settleTitleAttempt(record, task, { state: "done", durationMs, ...usageFields(result.usage) });
  }

  /**
   * 取得できた usage だけを試行へ足す。取消後 (state が skipped) でも記録し、
   * タイトルを適用するかとは独立に、送信済みの要求の費用を残す。
   */
  private recordTitleAttemptUsage(
    record: SessionRecord,
    task: { runId: string },
    usage: TitleSummaryUsage | undefined,
  ): void {
    if (record.clearingHistory) return;
    const attempt = record.titleAttempt;
    if (!attempt || attempt.runId !== task.runId || !usage) return;
    record.titleAttempt = { ...attempt, ...usageFields(usage) };
    void this.port.persist(record).then(() => {
      if (this.port.isLive(record)) this.port.resync(record);
    });
  }

  private settleTitleAttempt(
    record: SessionRecord,
    task: { runId: string },
    patch: Pick<TitleAttempt, "state"> &
      Partial<Pick<TitleAttempt, "inputTokens" | "outputTokens" | "costTotal" | "durationMs" | "error" | "skipReason">>,
  ): void {
    if (record.clearingHistory) return;
    const attempt = record.titleAttempt;
    if (!attempt || attempt.state !== "pending" || attempt.runId !== task.runId) return;
    record.titleAttempt = { ...attempt, ...patch };
    void this.port.persist(record).then(() => {
      if (this.port.isLive(record)) this.port.resync(record);
    });
  }

  /** 未開始 / 進行中の AI 要約を取り消す (設定を Off にしたとき)。予約済みの試行は残す */
  cancelAll(records: Iterable<SessionRecord>): void {
    for (const record of records) this.cancel(record);
  }

  cancel(record: SessionRecord): void {
    const task = record.titleTask;
    if (!task) return;
    delete record.titleTask;
    task.abort.abort();
    this.settleTitleAttempt(record, task, { state: "skipped", skipReason: "cancelled" });
  }
}

/** 補助呼び出しの usage を試行の記録へ写す (タイトルを採用できなくても消費した分を残す) */
function usageFields(usage: TitleSummaryUsage | undefined): Partial<TitleAttempt> {
  if (!usage) return {};
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costTotal: usage.costTotal,
  };
}
