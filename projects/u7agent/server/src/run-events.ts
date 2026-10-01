/**
 * ラン 1 回ぶんの pi イベント → SSE イベント変換。ストリーミング中の一時状態 (差分の保留・
 * 応答時間・送信メッセージの観測) だけをここが持ち、run / queue / subscriber のライフサイクルは
 * SessionStore に残す。SDK は完了時刻を持たないため、応答時間はイベントの到着時刻で測る。
 */
import { recordCompactionOutcome } from "./compaction-view";
import { classifyRunError, type RunErrorClassification } from "./error-classify";
import type { PiSessionEventListener, PiSessionLike } from "./pi-runtime";
import { contextUsageOf, lastAssistantMessage, parseUsage } from "./pi-runtime";
import { createStreamingSecretMasker, type SecretMasker } from "./redact";
import type { CompactionMeta } from "./session-record";
import type { MessageMetrics, SSEEventData, SSEEventType, ToolCall } from "./schema";
import { classifySkillRead, contentText, skillLoadOf, toolArgsSummary, toolResultSummary } from "./session-projection";

/**
 * 応答時間のうち BFF が測れる分を組む。tok/s は最初の delta からのスパンで割り、
 * スパンが無ければ全体の duration で割る。
 */
export function computeMessageMetrics({
  startedAt,
  firstTokenAt,
  endedAt,
  outputTokens,
}: {
  startedAt: number | undefined;
  firstTokenAt: number | undefined;
  endedAt: number;
  outputTokens: number | undefined;
}): MessageMetrics | undefined {
  if (startedAt === undefined) return undefined;
  const durationMs = endedAt - startedAt;
  if (durationMs < 0) return undefined;
  const metrics: MessageMetrics = { durationMs };
  if (firstTokenAt !== undefined) {
    const ttftMs = firstTokenAt - startedAt;
    if (ttftMs >= 0) metrics.ttftMs = ttftMs;
  }
  const streamSpan = firstTokenAt === undefined ? durationMs : endedAt - firstTokenAt;
  const span = streamSpan > 0 ? streamSpan : durationMs;
  if (span > 0 && outputTokens !== undefined && outputTokens > 0) {
    metrics.tokensPerSecond = (outputTokens * 1000) / span;
  }
  return metrics;
}

/** ランの終了理由。run_end の status と error 文言は受け取った側 (SessionStore) が決める */
export interface RunSettlement {
  stopped?: boolean;
  /** 分類済みのエラー (undefined は正常終了) */
  error?: RunErrorClassification;
}

/** auto_retry_start の通知。SessionStore が run.retry と累計を更新する */
export interface RetryScheduledEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface RunEventBridgeDeps {
  session: PiSessionLike;
  masker: SecretMasker;
  /** スキル読み込みの判定に使う絶対 session cwd (履歴側の workspaceAbs と同じ値) */
  cwd: string;
  /** 実行中ラン payload.run.toolCalls の実体 */
  tools: Map<string, ToolCall>;
  /** BFF 計測の応答時間を履歴のメッセージ参照へ結び付ける (同じ参照で引き当てる) */
  messageMetrics: WeakMap<object, MessageMetrics>;
  /** compaction entry に残らない値を entry id で控える */
  compactionMeta: Map<string, CompactionMeta>;
  emit: <T extends SSEEventType>(type: T, data: SSEEventData[T]) => void;
  emitResync: () => void;
  /** message_end / compaction_end のたびに呼ぶ。SDK は通知後に entry を append するため、呼び出し側で 1 拍置く */
  onPersist?: () => void;
  /**
   * 送信メッセージ (role user) の message_end。SDK は listener の後に同じ参照を entry へ append するため、
   * 呼び出し側はメッセージの参照を控えて履歴 item の run id に対応付ける
   */
  onPromptMessage?: (message: object) => void;
  /** 再試行のスケジュール / 再実行開始 / 解除を run へ反映する */
  onRetryScheduled: (event: RetryScheduledEvent) => void;
  onRetryAttemptStart: () => void;
  onRetryEnd: () => void;
  onSettled: (outcome: RunSettlement) => void;
}

export interface RunEventBridge {
  listener: PiSessionEventListener;
  /** 保留中の差分と resync を流し、以降のイベントを無視する (run_end を配る前に呼ぶ) */
  finalize: () => void;
  /**
   * このランで確定した最後の assistant 本文 (mask 済み)。このランで assistant メッセージを観測しなければ
   * undefined を返す (履歴を遡って前のランの本文を拾わない)。finalize の後に呼ぶ。
   */
  settledAssistantText: () => string | undefined;
}

export function createRunEventBridge(deps: RunEventBridgeDeps): RunEventBridge {
  const {
    session,
    masker,
    cwd,
    tools,
    messageMetrics,
    compactionMeta,
    emit,
    emitResync,
    onPersist,
    onPromptMessage,
    onRetryScheduled,
    onRetryAttemptStart,
    onRetryEnd,
    onSettled,
  } = deps;

  let finished = false;
  let currentAssistantText = "";
  // このランで assistant メッセージを観測したか。観測していないランの本文は空として扱う
  // (SDK は assistant を生成せずに agent_settled を配ることがある)。
  let assistantSeen = false;
  // このランで message_end を観測した assistant メッセージ。finalize の補完対象をここへ限定する
  // (SDK は失敗試行を context_edit で投影から外すため、投影の最後をそのまま信じると前の応答を再表示する)。
  const observedAssistants = new Set<object>();
  // 応答時間は assistant メッセージごとにリセットする
  let assistantStartedAt: number | undefined;
  let firstTokenAt: number | undefined;
  // 差分はそのまま配信せず、秘密値の前方一致になり得る末尾を保留する (アシスタントメッセージごとに作り直す)。
  let deltaMasker = createStreamingSecretMasker(masker);
  // 送信メッセージの message_end を観測済みか。SDK の prompt() は送信メッセージを組み立てる前に
  // compaction を走らせるため、その時点の resync は送信メッセージを欠いた履歴になる。
  let promptRecorded = false;
  let pendingCompactionResync = false;
  let retryActive = false;

  const pushText = (delta: string): void => {
    if (!delta) return;
    currentAssistantText += delta;
    emit("text", { delta });
  };

  /** 失敗試行の一時状態 (保留 delta・本文) を破棄する。SDK の context_edit が投影へ反映された後に呼ぶ */
  const discardAttempt = (): void => {
    currentAssistantText = "";
    deltaMasker = createStreamingSecretMasker(masker);
    assistantStartedAt = undefined;
    firstTokenAt = undefined;
  };

  const finalize = (): void => {
    if (finished) return;
    finished = true;

    // 補完対象はこのランで観測し、かつ SDK の最終投影に残っている assistant だけ。
    // 失敗試行 (context_edit で除外) や前のランの本文を、保留 delta の flush で再表示しない。
    const projected = lastAssistantMessage(session);
    if (projected && observedAssistants.has(projected)) {
      // 中断・エラー・正常完了のいずれでも、保留中の末尾をマスクして流す。
      pushText(deltaMasker.flush());
      // プロバイダは通常 text delta をストリームする。このフォールバックは
      // message_end で初めて最終テキストを含めるプロバイダ向け。
      const finalText = masker.mask(contentText(projected.content));
      if (finalText && !currentAssistantText) {
        pushText(finalText);
      } else if (finalText && currentAssistantText && finalText.startsWith(currentAssistantText)) {
        pushText(finalText.slice(currentAssistantText.length));
      }
    } else {
      discardAttempt();
      assistantSeen = false;
    }

    // 送信メッセージを観測できないままターンが終わった場合の保険 (通常は message_end で配る)
    if (pendingCompactionResync) {
      pendingCompactionResync = false;
      emitResync();
    }
  };

  const listener: PiSessionEventListener = (event) => {
    if (finished) return;
    try {
      // 保存は SDK の append 後に行う必要がある (呼び出し側が microtask で 1 拍置く)
      if (event.type === "message_end" || event.type === "compaction_end") onPersist?.();
      // SDK は prompt メッセージの message_end を配る前に agent state へ入れる。
      // それを待ってから、送信メッセージを欠いたままの resync を配る。
      if (event.type === "message_end" && event.message?.role === "user") {
        promptRecorded = true;
        onPromptMessage?.(event.message);
        if (pendingCompactionResync) {
          pendingCompactionResync = false;
          emitResync();
        }
      }
      switch (event.type) {
        case "agent_start":
          emit("status", { state: "thinking", text: "考え中…" });
          break;
        case "message_start":
          if (event.message?.role === "assistant") {
            assistantSeen = true;
            currentAssistantText = "";
            assistantStartedAt = Date.now();
            firstTokenAt = undefined;
            deltaMasker = createStreamingSecretMasker(masker);
            // 待機が終わって次の試行の本文が始まった時点を再実行の観測点にする (auto_retry_end は使わない)
            if (retryActive) onRetryAttemptStart();
          }
          break;
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent?.type === "text_delta") {
            firstTokenAt ??= Date.now();
            pushText(deltaMasker.push(assistantEvent.delta ?? ""));
          } else if (assistantEvent?.type === "thinking_delta") {
            // 思考だけが先に流れるモデルでも TTFT を測れる
            firstTokenAt ??= Date.now();
          }
          break;
        }
        case "message_end":
          if (event.message?.role === "assistant" && event.message) {
            assistantSeen = true;
            observedAssistants.add(event.message);
            pushText(deltaMasker.flush());
            const usage = parseUsage(event.message.usage);
            const metrics = computeMessageMetrics({
              startedAt: assistantStartedAt,
              firstTokenAt,
              endedAt: Date.now(),
              outputTokens: usage?.output,
            });
            if (metrics) messageMetrics.set(event.message, metrics);
            if (usage || metrics) {
              emit("usage", { usage, metrics, context: contextUsageOf(session) });
            }
            assistantStartedAt = undefined;
            firstTokenAt = undefined;
          }
          break;
        case "tool_execution_start": {
          const id = event.toolCallId ?? "";
          // 履歴 (projectMessages) と同じ関数で判定する。結果はまだ無いので isError は載せない
          const ref = classifySkillRead(event.args, { cwd, toolName: event.toolName ?? "" });
          const skill = ref ? skillLoadOf({ id, ref, masker }) : undefined;
          const tool: ToolCall = {
            id,
            name: event.toolName ?? "",
            args: toolArgsSummary(event.args, masker, cwd),
            isError: false,
            done: false,
            output: "",
            ...(skill ? { skill } : {}),
          };
          tools.set(tool.id, tool);
          emit("tool_start", { id: tool.id, name: tool.name, args: tool.args, ...(skill ? { skill } : {}) });
          emit("status", { state: "tool", text: `${tool.name} を実行中…` });
          break;
        }
        case "tool_execution_end": {
          const output = toolResultSummary(event.result, masker, cwd);
          const tool = tools.get(event.toolCallId ?? "");
          if (tool) {
            tool.done = true;
            tool.isError = Boolean(event.isError);
            tool.output = output;
          }
          emit("tool_end", {
            id: event.toolCallId ?? "",
            name: event.toolName ?? "",
            isError: Boolean(event.isError),
            output,
          });
          break;
        }
        case "compaction_start":
          emit("status", { state: "compacting", text: "会話を整理中…" });
          break;
        case "compaction_end": {
          const compactions = recordCompactionOutcome({ session, compactionMeta, masker, event });
          if (!compactions) break;
          emit("compaction", { compaction: compactions[compactions.length - 1], count: compactions.length });
          // 送信メッセージがまだ履歴に入っていなければ、入った時点 (message_end) まで遅らせる
          if (promptRecorded) emitResync();
          else pendingCompactionResync = true;
          break;
        }
        case "auto_retry_start": {
          retryActive = true;
          onRetryScheduled({
            attempt: event.attempt ?? 0,
            maxAttempts: event.maxAttempts ?? 0,
            delayMs: event.delayMs ?? 0,
            errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : "",
          });
          break;
        }
        case "entry_appended":
          // auto_retry_start は SDK が失敗メッセージを投影から外す (context_edit) 前に届き、
          // entry_appended の時点でも session.messages はまだ古い。microtask で 1 拍置いて、
          // 投影が更新された後にだけ resync を配る (失敗試行の表示を取り消す)。
          if (event.entry?.type === "context_edit") {
            queueMicrotask(() => {
              if (finished) return;
              discardAttempt();
              emitResync();
            });
          }
          break;
        case "auto_retry_end":
          // 系列の確定通知。待機終了の観測点には使わない (再実行の開始は次の message_start)。
          retryActive = false;
          onRetryEnd();
          break;
        case "extension_error":
          emit("status", {
            state: "warning",
            text: masker.mask(typeof event.error === "string" ? event.error : String(event.error ?? "")),
          });
          break;
        case "agent_end":
          if (event.willRetry) {
            emit("status", { state: "retry", text: "再試行を準備中…" });
          }
          break;
        case "agent_settled": {
          const finalAssistant = lastAssistantMessage(session);
          const error =
            finalAssistant?.stopReason === "error"
              ? classifyRunError(finalAssistant.errorMessage || "モデルの実行に失敗しました")
              : undefined;
          onSettled({
            stopped: finalAssistant?.stopReason === "aborted",
            ...(error ? { error } : {}),
          });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      onSettled({ error: classifyRunError(error) });
    }
  };

  return { listener, finalize, settledAssistantText: () => (assistantSeen ? currentAssistantText : undefined) };
}
