/**
 * ラン 1 回ぶんの pi イベント → SSE イベント変換。ストリーミング中の一時状態 (差分の保留・
 * 応答時間・送信メッセージの観測) だけをここが持ち、run / queue / subscriber のライフサイクルは
 * SessionStore に残す。SDK は完了時刻を持たないため、応答時間はイベントの到着時刻で測る。
 */
import { recordCompactionOutcome } from "./compaction-view";
import type { PiSessionEventListener, PiSessionLike } from "./pi-runtime";
import { contextUsageOf, lastAssistantMessage, parseUsage } from "./pi-runtime";
import { createStreamingSecretMasker, type SecretMasker } from "./redact";
import type { CompactionMeta } from "./session-record";
import type { MessageMetrics, SSEEventData, SSEEventType, ToolCall } from "./schema";
import { contentText, toolArgsSummary, toolResultSummary } from "./session-projection";

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
  error?: unknown;
}

export interface RunEventBridgeDeps {
  session: PiSessionLike;
  masker: SecretMasker;
  /** 実行中ラン payload.run.toolCalls の実体 */
  tools: Map<string, ToolCall>;
  /** BFF 計測の応答時間を履歴のメッセージ参照へ結び付ける (同じ参照で引き当てる) */
  messageMetrics: WeakMap<object, MessageMetrics>;
  /** compaction entry に残らない値を entry id で控える */
  compactionMeta: Map<string, CompactionMeta>;
  emit: <T extends SSEEventType>(type: T, data: SSEEventData[T]) => void;
  emitResync: () => void;
  onSettled: (outcome: RunSettlement) => void;
}

export interface RunEventBridge {
  listener: PiSessionEventListener;
  /** 保留中の差分と resync を流し、以降のイベントを無視する (run_end を配る前に呼ぶ) */
  finalize: () => void;
}

export function createRunEventBridge(deps: RunEventBridgeDeps): RunEventBridge {
  const { session, masker, tools, messageMetrics, compactionMeta, emit, emitResync, onSettled } = deps;

  let finished = false;
  let currentAssistantText = "";
  // 応答時間は assistant メッセージごとにリセットする
  let assistantStartedAt: number | undefined;
  let firstTokenAt: number | undefined;
  // 差分はそのまま配信せず、秘密値の前方一致になり得る末尾を保留する (アシスタントメッセージごとに作り直す)。
  let deltaMasker = createStreamingSecretMasker(masker);
  // 送信メッセージの message_end を観測済みか。SDK の prompt() は送信メッセージを組み立てる前に
  // compaction を走らせるため、その時点の resync は送信メッセージを欠いた履歴になる。
  let promptRecorded = false;
  let pendingCompactionResync = false;

  const pushText = (delta: string): void => {
    if (!delta) return;
    currentAssistantText += delta;
    emit("text", { delta });
  };

  const finalize = (): void => {
    if (finished) return;
    finished = true;

    // 中断・エラー・正常完了のいずれでも、保留中の末尾をマスクして流す。
    pushText(deltaMasker.flush());

    // プロバイダは通常 text delta をストリームする。このフォールバックは
    // message_end で初めて最終テキストを含めるプロバイダ向け。
    const finalText = masker.mask(contentText(lastAssistantMessage(session)?.content));
    if (finalText && !currentAssistantText) {
      pushText(finalText);
    } else if (finalText && currentAssistantText && finalText.startsWith(currentAssistantText)) {
      pushText(finalText.slice(currentAssistantText.length));
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
      // SDK は prompt メッセージの message_end を配る前に agent state へ入れる。
      // それを待ってから、送信メッセージを欠いたままの resync を配る。
      if (event.type === "message_end" && event.message?.role === "user") {
        promptRecorded = true;
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
            currentAssistantText = "";
            assistantStartedAt = Date.now();
            firstTokenAt = undefined;
            deltaMasker = createStreamingSecretMasker(masker);
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
          if (event.message?.role === "assistant") {
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
          const tool: ToolCall = {
            id: event.toolCallId ?? "",
            name: event.toolName ?? "",
            args: toolArgsSummary(event.args, masker),
            isError: false,
            done: false,
            output: "",
          };
          tools.set(tool.id, tool);
          emit("tool_start", { id: tool.id, name: tool.name, args: tool.args });
          emit("status", { state: "tool", text: `${tool.name} を実行中…` });
          break;
        }
        case "tool_execution_end": {
          const output = toolResultSummary(event.result, masker);
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
        case "auto_retry_start":
          emit("status", {
            state: "retry",
            text: `再試行中… (${event.attempt}/${event.maxAttempts})`,
          });
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
          onSettled({
            stopped: finalAssistant?.stopReason === "aborted",
            ...(finalAssistant?.stopReason === "error"
              ? { error: finalAssistant.errorMessage || "モデルの実行に失敗しました" }
              : {}),
          });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      onSettled({ error });
    }
  };

  return { listener, finalize };
}
