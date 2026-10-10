/**
 * SessionRecord から DTO (SessionPayload / SessionSummary) を組む。マスクは record の生値へ掛ける
 * (DTO へコピーしてから掛けると、マスクや切り詰めの抜けが漏洩に直結する)。
 */
import { workspaceAbs } from "./app-paths";
import { compactionsOf } from "./compaction-view";
import { contextUsageOf } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { SessionRecord } from "./session-record";
import { displayableMessages, projectMessages, truncate } from "./session-projection";
import type { RunStatus, SessionPayload, SessionSummary, ThinkingLevel } from "./schema";

const PROMPT_TEXT_MAX = 300;

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
  // 待機中の run id -> 順位 (1 始まり)。順位は record.queue の index が正で、unsentSends の並び
  // (受理順) は再送でキューの並びと入れ替わるため、順位として数えさせない
  const queuedPositions = new Map(record.queue.map((item, index) => [item.runId, index + 1]));
  // 実行中の run id。終了した run (record.run は status が付いたまま残る) は除く
  const runningRunId =
    record.run && (record.run.status === "running" || session.isStreaming) ? record.run.id : undefined;
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
    // 受理済みでまだ entry になっていない送信を状態付きで配る。`unsent` は「未送信」の表示へ、
    // `queued` / `running` は pending エコーのまま扱う (表示から消さない)。本文は表示用にマスクし、
    // 再送は run id だけを送ってもらう (マスク済みの本文を送り直させない)
    pendingSends: record.unsentSends.map((item) => {
      const position = queuedPositions.get(item.runId);
      return {
        runId: item.runId,
        text: masker.mask(item.text),
        at: item.at,
        state: position !== undefined ? "queued" : runningRunId === item.runId ? "running" : "unsent",
        ...(position !== undefined ? { position } : {}),
      };
    }),
    ...(record.compactionStartedAt !== undefined ? { compactionStartedAt: record.compactionStartedAt } : {}),
    notify: record.notify,
    pinned: record.pinned,
    lastSeq: record.seq,
    agent: {
      ...record.agent,
      skillIds: [...record.agent.skillIds],
      skills: record.agent.skills.map((skill) => ({ ...skill })),
    },
    run: record.run
      ? {
          id: record.run.id,
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
    messages: projectMessages(session, record.messageMetrics, masker, workspaceAbs(rootCwd, cwd), record.toolTimings),
    compactions: compactionsOf(record, masker),
    ...(context ? { context } : {}),
  };
}

export function projectSessionSummary({
  record,
  status,
  projectId,
  masker,
}: {
  record: SessionRecord;
  status: RunStatus;
  projectId?: string;
  masker: SecretMasker;
}): SessionSummary {
  return {
    sessionId: record.id,
    spaceId: record.meta.spaceId ?? "default",
    title: record.title || "無題のセッション",
    agentId: record.agentId,
    agentName: record.agent.name,
    status,
    queueDepth: record.queue.length,
    notify: record.notify,
    pinned: record.pinned,
    messageCount: displayableMessages(record.session, masker).length,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    model: modelLabel(record.session.model),
    ...(projectId ? { projectId } : {}),
  };
}
