/**
 * SessionRecord から DTO (SessionPayload / SessionSummary) を組む。マスクは record の生値へ掛ける
 * (DTO へコピーしてから掛けると、マスクや切り詰めの抜けが漏洩に直結する)。
 */
import { workspaceAbs } from "./app-paths";
import { compactionsOf } from "./compaction-view";
import { contextUsageOf } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { SessionRecord } from "./session-record";
import { displayableMessages, projectMessages, truncate, unprojectedAssistantMeta } from "./session-projection";
import { batchesSteering, sdkQueueLength, takenSendIdsOf } from "./session-steering";
import type { PendingSend, RunStatus, SessionPayload, SessionSummary, ThinkingLevel } from "./schema";

const PROMPT_TEXT_MAX = 300;

/**
 * payload の `run.toolCalls` が指す応答のうち、表示 item を持たないもの (クライアントが合成しうる応答)。
 * `projected` は payload.messages に載った応答の assistantId で、その応答の値は履歴 item が持つ。
 */
function unprojectedOwners(record: SessionRecord, projected: ReadonlySet<string>): Set<string> {
  const owners = new Set<string>();
  for (const call of record.tools.values()) {
    if (call.assistantId === undefined || projected.has(call.assistantId)) continue;
    owners.add(call.assistantId);
  }
  return owners;
}

/**
 * 受理済みでまだ entry になっていない送信を状態付きで配る。待機順位は BFF の配送キュー (SDK へ
 * 渡した分も含む) の index が正で、unsentSends の受理順は順位に使わない。
 */
export function pendingSendsOf(record: SessionRecord, masker: SecretMasker): PendingSend[] {
  const positions = new Map(record.queue.map((item, index) => [item.sendId, index + 1]));
  // 実キューに残っている間は取消できる `queued`、SDK が取り出したら `steering` (反映中)。
  // 一括ドレインを持たない SDK は「渡した 1 件が実キューから消えたか」で同じ判定をする
  const taken = batchesSteering(record) ? takenSendIdsOf(record) : undefined;
  const sdkQueue = taken === undefined ? sdkQueueLength(record) : 0;
  return record.unsentSends.map((item) => {
    const queued = record.queue.find((candidate) => candidate.sendId === item.sendId);
    const position = positions.get(item.sendId);
    const state: PendingSend["state"] =
      queued === undefined
        ? record.run?.status === "running" && record.run.initialSendId === item.sendId
          ? "running"
          : record.injectedSends.has(item.sendId)
            ? "running"
            : "unsent"
        : taken === undefined
          ? queued.handedOff === true && sdkQueue === 0
            ? "steering"
            : "queued"
          : queued.handedOff === true && taken.has(queued.sendId)
            ? "steering"
            : "queued";
    return {
      sendId: item.sendId,
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      text: masker.mask(item.text),
      at: item.at,
      state,
      ...(position === undefined ? {} : { position }),
    };
  });
}

function modelLabel(model?: { provider: string; id: string } | null): string | undefined {
  if (!model || (model.provider === "unknown" && model.id === "unknown")) return undefined;
  return `${model.provider}/${model.id}`;
}

export function projectSessionPayload({
  record,
  status,
  cwd,
  projectId,
  masker,
  rootCwd,
}: {
  record: SessionRecord;
  status: RunStatus;
  cwd: string;
  projectId?: string;
  masker: SecretMasker;
  /** 相対 cwd を絶対へ解決し、スキル読み込み判定をライブ経路と同じ cwd に揃えるために使う */
  rootCwd: string;
}): SessionPayload {
  const { session } = record;
  const availableThinkingLevels = (session.getAvailableThinkingLevels() ??
    (session.thinkingLevel ? [session.thinkingLevel] : [])) as ThinkingLevel[];
  const context = contextUsageOf(session);
  const messages = projectMessages(
    session,
    record.messageMetrics,
    masker,
    workspaceAbs(rootCwd, cwd),
    record.toolTimings,
    record.assistantMessageIds,
    record.userMessageSends,
  );
  // 表示 item にならない応答のメタ情報は、この payload が載せるツールカードの所有者だけに絞る
  // (履歴 item が持つ値を二重に載せず、長い会話でも payload を大きくしない)
  const assistantMeta = unprojectedAssistantMeta(
    session.messages,
    { messageMetrics: record.messageMetrics, assistantIds: record.assistantMessageIds },
    unprojectedOwners(
      record,
      new Set(messages.flatMap((message) => (message.assistantId === undefined ? [] : [message.assistantId]))),
    ),
  );
  // 待機中の run id -> 順位 (1 始まり)。順位は record.queue の index が正で、unsentSends の並び
  // (受理順) は再送でキューの並びと入れ替わるため、順位として数えさせない
  return {
    sessionId: record.id,
    spaceId: record.meta.spaceId ?? "default",
    piSessionId: session.sessionId,
    cwd,
    eventGeneration: record.generation,
    ...(projectId ? { projectId } : {}),
    model: modelLabel(session.model),
    thinkingLevel: session.thinkingLevel,
    supportsThinking: session.supportsThinking(),
    availableThinkingLevels,
    status,
    title: record.title,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    // retryAt との差でクライアントが残り時間を出す基準時刻 (ブラウザ時計と比較しない)
    serverNow: Date.now(),
    queueDepth: record.queue.length,
    // 受理済みでまだ entry になっていない送信を状態付きで配る (`unsent` は「未送信」の表示へ、
    // `queued` / `steering` / `running` は pending エコーのまま扱う)。本文は表示用にマスクし、
    // 再送は送信IDだけを送ってもらう (マスク済みの本文を送り直させない)
    pendingSends: pendingSendsOf(record, masker),
    ...(record.compactionStartedAt !== undefined ? { compactionStartedAt: record.compactionStartedAt } : {}),
    notify: record.notify,
    pinned: record.pinned,
    lastSeq: record.seq,
    agent: { ...record.agent },
    run: record.run
      ? {
          id: record.run.id,
          initialSendId: record.run.initialSendId,
          status: record.run.status,
          startedAt: record.run.startedAt,
          endedAt: record.run.endedAt,
          error: record.run.error,
          // 復元 (リロード / SSE 再接続) でも再実行カードを出せるように、run_end だけに依存せず載せる
          ...(record.run.errorCode ? { errorCode: record.run.errorCode } : {}),
          prompt: truncate(record.run.prompt, PROMPT_TEXT_MAX),
          toolCalls: [...record.tools.values()],
          ...(record.run.retry ? { retry: { ...record.run.retry } } : {}),
          totalRetryCount: record.run.totalRetryCount,
        }
      : null,
    messages,
    ...(assistantMeta.length > 0 ? { assistantMeta } : {}),
    compactions: compactionsOf(record, masker, workspaceAbs(rootCwd, cwd)),
    // 引き継ぎの状態は meta が正 (クライアントのメモリでは持たない)。片付けの印もここで合成する
    ...(record.meta.handoff
      ? {
          handoff: {
            operationId: record.meta.handoff.operationId,
            at: record.meta.handoff.at,
            memo: record.meta.handoff.memo,
            consumed: record.meta.handoff.consumed,
            cleanupPending: record.meta.handoffCleanup === true,
          },
        }
      : {}),
    ...(context ? { context } : {}),
  };
}

export function projectSessionSummary({
  record,
  status,
  awaitingAnswer,
  awaitingSince,
  lastRunDurationMs,
  projectId,
  masker,
  cwd,
  hasRawLog,
  serveCommand,
}: {
  record: SessionRecord;
  status: RunStatus;
  /** `record` は待機を持つので、この経路では常に真偽値を載せる (未ロードの summaryOfMeta は載せない) */
  awaitingAnswer: boolean;
  /** 未 settle の質問のうち最も古い開始時刻 (回答待ちの経過時間の起点) */
  awaitingSince?: number;
  /** 直近のランの所要時間。runOutcomes に無ければ省略する */
  lastRunDurationMs?: number;
  projectId?: string;
  masker: SecretMasker;
  /** スキル読み込みの判定に使う絶対 cwd。件数を履歴ページと同じ表示集合で数えるために要る */
  cwd: string;
  /** 生ログ (session.jsonl) がディスクにあるか。UI のダウンロードの出し分けだけに使う */
  hasRawLog: boolean;
  /** その作業ディレクトリの serve 成功実績。無ければ null (実行状況からの起動可否) */
  serveCommand: string | null;
}): SessionSummary {
  return {
    sessionId: record.id,
    spaceId: record.meta.spaceId ?? "default",
    title: record.title || "無題のセッション",
    agentId: record.agentId,
    agentName: record.agent.name,
    status,
    awaitingAnswer,
    queueDepth: record.queue.length,
    notify: record.notify,
    pinned: record.pinned,
    canHandoff: true,
    projectSession: record.projectCwd !== undefined,
    ...(record.meta.handoffCleanup ? { handoffCleanup: true } : {}),
    hasRawLog,
    messageCount: displayableMessages(record.session, masker, cwd).length,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    serveCommand,
    model: modelLabel(record.session.model),
    // 時刻は live な実行からだけ載せる。未ロードの会話 (summaryOfMeta) は idle で時刻を持たない
    ...(record.run ? { runStartedAt: record.run.startedAt } : {}),
    ...(record.run?.endedAt !== undefined ? { finishedAt: record.run.endedAt } : {}),
    ...(lastRunDurationMs !== undefined ? { lastRunDurationMs } : {}),
    ...(record.compactionStartedAt !== undefined ? { compactionStartedAt: record.compactionStartedAt } : {}),
    ...(awaitingSince !== undefined ? { awaitingSince } : {}),
    ...(projectId ? { projectId } : {}),
  };
}
