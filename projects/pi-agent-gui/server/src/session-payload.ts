/**
 * SessionRecord から DTO (SessionPayload / SessionSummary) を組む。マスクは record の生値へ掛ける
 * (DTO へコピーしてから掛けると、マスクや切り詰めの抜けが漏洩に直結する)。
 */
import { contextUsageOf } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import { compactionsOf } from "./compaction-view";
import type { SessionRecord } from "./session-record";
import { projectMessages, truncate } from "./session-projection";
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
  masker,
}: {
  record: SessionRecord;
  status: RunStatus;
  cwd: string;
  masker: SecretMasker;
}): SessionPayload {
  const { session } = record;
  const availableThinkingLevels = (session.getAvailableThinkingLevels() ??
    (session.thinkingLevel ? [session.thinkingLevel] : [])) as ThinkingLevel[];
  const context = contextUsageOf(session);
  return {
    sessionId: record.id,
    piSessionId: session.sessionId,
    cwd,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    model: modelLabel(session.model),
    thinkingLevel: session.thinkingLevel,
    supportsThinking: session.supportsThinking(),
    availableThinkingLevels,
    status,
    title: record.title,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    queueDepth: record.queue.length,
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
          prompt: truncate(record.run.prompt, PROMPT_TEXT_MAX),
          toolCalls: [...record.tools.values()],
        }
      : null,
    messages: projectMessages(session, record.messageMetrics, masker),
    compactions: compactionsOf(record, masker),
    ...(context ? { context } : {}),
  };
}

export function projectSessionSummary({
  record,
  status,
  masker,
}: {
  record: SessionRecord;
  status: RunStatus;
  masker: SecretMasker;
}): SessionSummary {
  return {
    sessionId: record.id,
    title: record.title || "無題のセッション",
    agentId: record.agentId,
    agentName: record.agent.name,
    status,
    queueDepth: record.queue.length,
    messageCount: projectMessages(record.session, record.messageMetrics, masker).length,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    model: modelLabel(record.session.model),
    ...(record.projectId ? { projectId: record.projectId } : {}),
  };
}
