/**
 * `investigate` の子 runner。子は使い捨ての pi セッションで 1 ショットだけ走らせ、SessionStore には
 * 載せない (record / JSONL / SSE / 購読を持たず、掃除は親 run の signal にだけ寄せる)。
 * 会話ごとの並列上限と待ち行列の在庫もここが持つ (`docs/subagent.md`)。
 */
import type { InvestigateProgress, InvestigateRunResult } from "./investigate-tool";
import type { PiSessionEventListener, PiSessionLike } from "./pi-runtime";
import { lastAssistantMessage, parseUsage } from "./pi-runtime";
import type { SecretMasker } from "./redact";
import type { AgentDef, ModelRef, Usage } from "./schema";
import { contentText, toolArgsSummary } from "./session-projection";

/** 会話ごとに同時に走らせる子の数。超過分は待ち行列へ積む */
export const INVESTIGATE_PARALLEL_MAX = 3;

/** 進捗の間引き幅。ツール境界では間引かずに流す */
export const INVESTIGATE_PROGRESS_INTERVAL_MS = 400;

/** 1 回の進捗に載せる本文の上限 (末尾) */
export const INVESTIGATE_PROGRESS_TEXT_MAX = 200;
export const INVESTIGATE_PROGRESS_TEXT_LINES = 3;

export const INVESTIGATION_AGENT_ID = "investigation";

const INVESTIGATION_SYSTEM_PROMPT = [
  "You are an investigation sub-agent. Another agent delegated one read-only investigation to you and reads only your final message.",
  "Work read-only: you cannot change files, cannot ask the user, and cannot delegate another investigation.",
  "Answer in the language of the request unless it asks for another language.",
  "Report the conclusion first, then the evidence, then the paths of the files you actually read, so the caller can verify the answer.",
  "Keep it concise: the caller has a small budget for your report.",
].join("\n");

/** 子セッションの合成 AgentDef。カタログに無い定義で、スキルは割り当てない */
export const INVESTIGATION_AGENT: AgentDef = {
  id: INVESTIGATION_AGENT_ID,
  name: INVESTIGATION_AGENT_ID,
  description: "使い捨ての読み取り専用調査",
  systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
  skillIds: [],
};

export interface InvestigateRunRequest {
  /** 親の会話 id。並列数と待ち行列のキー */
  sessionId: string;
  /** 子セッションの作業ディレクトリ (rootCwd 相対)。親と同じ場所で調査させる */
  cwd: string;
  /** 親セッションの現在のモデル。未指定は既定モデルで走らせる */
  model?: ModelRef;
  prompt: string;
  /** 親 run の stop とツールのタイムアウトを合成した signal */
  signal: AbortSignal;
  onProgress?: (progress: InvestigateProgress) => void;
}

export interface InvestigateRunner {
  investigate(request: InvestigateRunRequest): Promise<InvestigateRunResult>;
}

export interface InvestigateChildInput {
  ownerSessionId: string;
  cwd: string;
  model?: ModelRef;
  agent: AgentDef;
}

export interface InvestigateRunnerOptions {
  /** 子セッションを作る。子モードの固定は呼び出し側 (SessionStore) が持つ */
  createChildSession: (input: InvestigateChildInput) => Promise<PiSessionLike>;
  /** 進捗の文字列から秘密値を除く */
  masker: SecretMasker;
  maxParallel?: number;
  progressIntervalMs?: number;
  /** 進捗の間引きに使う現在時刻 (テスト用) */
  now?: () => number;
}

/** 会話 1 件分の在庫。子は record を持たないため、進行中の本数はここだけが数える */
interface SessionQueue {
  active: number;
  max: number;
  /** 解放待ち。呼ぶと 1 枠を引き継いで開始する */
  waiting: Array<() => void>;
}

const abortedResult = (): InvestigateRunResult => ({ outcome: "aborted", report: "", toolCalls: 0 });

function queueOf(registry: Map<string, SessionQueue>, sessionId: string, max: number): SessionQueue {
  const existing = registry.get(sessionId);
  if (existing) return existing;
  const created: SessionQueue = { active: 0, max, waiting: [] };
  registry.set(sessionId, created);
  return created;
}

/** 空き枠を取る。取れない間は待ち、abort では待たずに false を返す */
function acquire(queue: SessionQueue, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (queue.active < queue.max) {
    queue.active += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (started: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(started);
    };
    const start = (): void => {
      queue.active += 1;
      settle(true);
    };
    const onAbort = (): void => {
      const index = queue.waiting.indexOf(start);
      if (index >= 0) queue.waiting.splice(index, 1);
      settle(false);
    };
    queue.waiting.push(start);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function release(queue: SessionQueue, registry: Map<string, SessionQueue>, sessionId: string): void {
  queue.active -= 1;
  queue.waiting.shift()?.();
  // 枠も待ちも無くなった会話の在庫は残さない (親 run が終われば子も終わっている)
  if (queue.active === 0 && queue.waiting.length === 0) registry.delete(sessionId);
}

function tailText(text: string): string {
  const tail = text.split("\n").slice(-INVESTIGATE_PROGRESS_TEXT_LINES).join("\n");
  return tail.length > INVESTIGATE_PROGRESS_TEXT_MAX ? tail.slice(tail.length - INVESTIGATE_PROGRESS_TEXT_MAX) : tail;
}

interface ProgressEmitter {
  /** 本文 delta 向け: 間引いて流す */
  update(activity: string, text: string): void;
  /** ツール境界向け: 間引かずに流す */
  flush(activity: string, text: string): void;
  /** 保留を捨てる (終了経路の後始末) */
  stop(): void;
}

function createProgressEmitter(
  onProgress: ((progress: InvestigateProgress) => void) | undefined,
  masker: SecretMasker,
  intervalMs: number,
  now: () => number,
): ProgressEmitter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending: InvestigateProgress | undefined;

  const send = (): void => {
    timer = undefined;
    const next = pending;
    pending = undefined;
    lastAt = now();
    if (!next || !onProgress) return;
    // 累積原文の末尾を本文上限で切る前に保留する。切った後では、生成途中の秘密値が先頭を失った
    // 中間の断片になり、完全一致でも先頭部分一致でも検出できなくなる (maskAccumulated)
    onProgress({
      activity: masker.maskSafe(next.activity),
      text: tailText(masker.maskSafe(masker.maskAccumulated(next.text))),
    });
  };

  return {
    update(activity, text) {
      if (!onProgress) return;
      pending = { activity, text };
      if (timer !== undefined) return;
      const wait = intervalMs - (now() - lastAt);
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    },
    flush(activity, text) {
      if (!onProgress) return;
      pending = { activity, text };
      if (timer !== undefined) clearTimeout(timer);
      send();
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

function addUsage(total: Usage | undefined, next: Usage): Usage {
  if (!total) return next;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(total.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined
      ? { cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }
      : {}),
    ...(total.reasoning !== undefined || next.reasoning !== undefined
      ? { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }
      : {}),
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  };
}

/**
 * 子の報告。最後の assistant 本文を正とし、中断で本文が届いていなければ受信済みの delta を使う
 * (途中で生成されたテキストは報告ではなく live 表示のためのもの)。
 */
function reportOf(session: PiSessionLike, streamed: string): string {
  const message = lastAssistantMessage(session);
  const final = message ? contentText(message.content).trim() : "";
  return final !== "" ? final : streamed.trim();
}

function childPrompt(request: string): string {
  return [
    "Investigate the following request and report back.",
    "Order: conclusion, then the evidence, then the referenced file paths.",
    "",
    "---",
    request,
  ].join("\n");
}

export function createInvestigateRunner(options: InvestigateRunnerOptions): InvestigateRunner {
  const maxParallel = options.maxParallel ?? INVESTIGATE_PARALLEL_MAX;
  const progressIntervalMs = options.progressIntervalMs ?? INVESTIGATE_PROGRESS_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const registry = new Map<string, SessionQueue>();

  async function runChild(request: InvestigateRunRequest): Promise<InvestigateRunResult> {
    const counters = { toolCalls: 0, compactions: 0, usage: undefined as Usage | undefined };
    let streamed = "";
    let activity = "";
    const progress = createProgressEmitter(request.onProgress, options.masker, progressIntervalMs, now);

    const listener: PiSessionEventListener = (event) => {
      switch (event.type) {
        case "tool_execution_start":
          counters.toolCalls += 1;
          activity = `${event.toolName ?? ""} ${toolArgsSummary(event.args, options.masker, "")}`.trim();
          progress.flush(activity, streamed);
          break;
        case "message_start":
          if (event.message?.role === "assistant") streamed = "";
          break;
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            streamed += event.assistantMessageEvent.delta ?? "";
            progress.update(activity, streamed);
          }
          break;
        case "message_end":
          if (event.message?.role === "assistant") {
            const usage = parseUsage(event.message.usage);
            if (usage) counters.usage = addUsage(counters.usage, usage);
          }
          break;
        case "compaction_end":
          if (event.result) counters.compactions += 1;
          break;
        default:
          break;
      }
    };

    let session: PiSessionLike;
    try {
      session = await options.createChildSession({
        ownerSessionId: request.sessionId,
        cwd: request.cwd,
        ...(request.model ? { model: request.model } : {}),
        agent: INVESTIGATION_AGENT,
      });
    } catch {
      // 子を作れなかった (モデルの許可リスト外など)。理由の文言はツール側が付ける
      progress.stop();
      return { outcome: "error", report: "", toolCalls: 0 };
    }

    const unsubscribe = session.subscribe(listener);
    try {
      if (request.signal.aborted) return { outcome: "aborted", report: "", ...counters };
      // prompt() の解決を待たずに親の stop へ反応する (そこで打ち切った部分報告を返す)
      const finished = session.prompt(childPrompt(request.prompt)).then(
        () => "done" as const,
        () => "failed" as const,
      );
      let detach = (): void => {};
      const aborted = new Promise<"aborted">((resolve) => {
        if (request.signal.aborted) {
          resolve("aborted");
          return;
        }
        const onAbort = (): void => resolve("aborted");
        request.signal.addEventListener("abort", onAbort, { once: true });
        detach = () => request.signal.removeEventListener("abort", onAbort);
      });
      const settled = await Promise.race([finished, aborted]);
      detach();
      if (settled === "aborted") {
        // SDK の abort() は実行と compaction の巻き戻しを待つ。子は resume しないので後片付けだけする
        await session.abort().catch(() => {});
        return { outcome: "aborted", report: reportOf(session, streamed), ...counters };
      }
      if (settled === "failed" || lastAssistantMessage(session)?.stopReason === "error") {
        // prompt() の解決は成功を意味しない (SDK は provider の失敗や retry 枯渇を最後の assistant の
        // stopReason に載せる) ため、解決後も終了理由を確かめてから失敗へ寄せる
        return { outcome: "error", report: reportOf(session, streamed), ...counters };
      }
      return { outcome: "completed", report: reportOf(session, streamed), ...counters };
    } finally {
      unsubscribe();
      progress.stop();
      try {
        session.dispose?.();
      } catch {
        // dispose の失敗は結果へ影響させない (子は使い捨てで、記録も購読も残っていない)
      }
    }
  }

  return {
    async investigate(request: InvestigateRunRequest): Promise<InvestigateRunResult> {
      const queue = queueOf(registry, request.sessionId, maxParallel);
      if (!(await acquire(queue, request.signal))) return abortedResult();
      try {
        return await runChild(request);
      } finally {
        release(queue, registry, request.sessionId);
      }
    },
  };
}
