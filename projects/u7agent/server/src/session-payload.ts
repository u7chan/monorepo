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
  // 実行中 / キュー待ちの run id。未送信の一覧から外し、送信中は pending エコーのまま見せる。
  // record.run は終了後も status 付きで残るため、running / streaming のときだけ実行中として扱う
  // (終了した run の送信を未送信として再送 / 破棄できるようにする)
  const activeRunIds = new Set<string>([
    ...(record.run && (record.run.status === "running" || session.isStreaming) ? [record.run.id] : []),
    ...record.queue.map((item) => item.runId),
  ]);
  return {
    sessionId: record.id,
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
    // 保存されなかった送信は「未送信」として見せる。ただし実行中 / キュー中の run は送信中なので外す
    // (クライアントの pending エコーが担う。再送直後に未送信へ引き戻さない)。本文は表示用にマスクし、
    // 再送は run id だけを送ってもらう (マスク済みの本文を送り直させない)
    unsentMessages: record.unsentSends
      .filter((item) => !activeRunIds.has(item.runId))
      .map((item) => ({ runId: item.runId, text: masker.mask(item.text), at: item.at })),
    ...(record.compactionStartedAt !== undefined ? { compactionStartedAt: record.compactionStartedAt } : {}),
    notify: record.notify,
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
    messages: projectMessages(session, record.messageMetrics, masker, workspaceAbs(rootCwd, cwd)),
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
    title: record.title || "無題のセッション",
    agentId: record.agentId,
    agentName: record.agent.name,
    status,
    queueDepth: record.queue.length,
    notify: record.notify,
    messageCount: displayableMessages(record.session, masker).length,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    model: modelLabel(record.session.model),
    ...(projectId ? { projectId } : {}),
  };
}
