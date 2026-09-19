/**
 * テスト共通の pi ランタイム / セッションスタブ。実 API は呼ばず、createAgentSession() のイベントフロー
 * (subscribe / prompt / abort / agent_settled) を模倣し、thinkingLevel の能力判定と補正は SDK 公開ヘルパーをそのまま使う。
 */
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import type { PiBff } from "../src/agent";
import type { AgentDef, ContextUsage, ModelOption, ModelRef, SkillDef, ThinkingLevel, Usage } from "../src/schema";
import type { PiSessionEvent, PiSessionLike, PiSessionEventListener } from "../src/sessions";

export interface StubModelInput {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/** SDK の Model として振る舞うのに必要な最小フィールドを埋める */
export function stubModel(input: StubModelInput): PiAiModel<Api> {
  return {
    api: "openai-completions",
    baseUrl: "https://stub.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...input,
  } as PiAiModel<Api>;
}

export const STUB_MODEL = stubModel({
  provider: "stub",
  id: "stub-model",
  name: "Stub Model",
  reasoning: true,
});

/** 非推論モデル (getSupportedThinkingLevels は ["off"] を返す) */
export const STUB_PLAIN_MODEL = stubModel({
  provider: "stub",
  id: "stub-plain",
  name: "Stub Plain",
  reasoning: false,
});

/** xhigh だけ対応している推論モデル (段階の穴の検証用) */
export const STUB_HOLE_MODEL = stubModel({
  provider: "stub",
  id: "stub-hole",
  name: "Stub Hole",
  reasoning: true,
  thinkingLevelMap: { minimal: null, xhigh: "reasoning_effort_xhigh" },
});

export function modelOptionOf(model: PiAiModel<Api>): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    supportsThinking: getSupportedThinkingLevels(model).some((level) => level !== "off"),
    thinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
  };
}

/** assistant メッセージに載せる既定の usage (provider が報告する値を模する) */
export const STUB_USAGE: Usage = {
  input: 1234,
  output: 56,
  cacheRead: 789,
  cacheWrite: 12,
  reasoning: 21,
  totalTokens: 2091,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0001, total: 0.0034 },
};

/** getContextUsage() の既定値 (分母はモデルの contextWindow に合わせる) */
export const STUB_CONTEXT_USAGE: ContextUsage = {
  tokens: 43_008,
  contextWindow: 128_000,
  percent: 33.6,
};

export interface StubSessionOptions {
  reply?: string;
  chunkDelayMs?: number;
  /** setModel を遅延させる (設定変更中の競合テスト用) */
  setModelDelayMs?: number;
  model?: PiAiModel<Api>;
  thinkingLevel?: string;
  /** 最初の N 回だけ setModel を失敗させる (ガード解除の検証用) */
  setModelFailures?: number;
  /** assistant へ載せる usage。null で usage 非対応プロバイダ (キー省略) を再現する */
  usage?: Usage | null;
  /** getContextUsage() の戻り値。null で SDK 非対応 (undefined を返す) を再現する */
  contextUsage?: ContextUsage | null;
  /** compaction 直後の再現: SDK が履歴へ入れるまで getContextUsage() が返す値 */
  contextUsageBeforeHistory?: ContextUsage;
  /** 最初の delta の前に送る thinking_delta の本文 (TTFT の検証用) */
  thinkingDelta?: string;
  /** 復元: BFF が読んだ entry。SDK の inMemory(cwd, id, entries) と同じく初期履歴として使う */
  entries?: unknown[];
  /** 復元: SDK セッションの id (BFF のセッション id) */
  sessionId?: string;
  /**
   * prompt ごとに 1 件消費する preflight compaction (null は圧縮しない)。
   * 実 SDK は送信メッセージを組み立てる前に compaction を走らせる。
   */
  preflightCompactions?: Array<StubCompactionOptions | null>;
}

/** SDK の SessionEntry と同じ形の append-only ログ。getBranch() が返す */
export interface StubSessionEntry {
  type: "message" | "model_change" | "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  /** type === "message" のとき。session.messages と同じ参照を保つ */
  message?: {
    role: string;
    content: unknown;
    stopReason?: string;
    errorMessage?: string;
    timestamp?: number;
    usage?: unknown;
  };
  /** type === "compaction" */
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  usage?: unknown;
  fromHook?: boolean;
  /** type === "model_change" (実 SDK と同じく復元の手がかりになる) */
  provider?: string;
  modelId?: string;
  /** type === "thinking_level_change" */
  thinkingLevel?: string;
}

export interface StubCompactionOptions {
  reason?: "manual" | "threshold" | "overflow";
  /** 先頭から何件の表示メッセージを要約へ置き換えるか。未指定は最後の 2 件を残す */
  summarizeCount?: number;
  /** "none" / "aborted" / "error" で result が無い異常系を再現する */
  outcome?: "ok" | "none" | "aborted" | "error";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** firstKeptEntryId が metadata entry (model 変更) を指す SDK の挙動を再現する */
  firstKeptIsMetadata?: boolean;
  usage?: Usage;
  fromHook?: boolean;
}

export interface StubSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
  abortRequested: boolean;
  disposed: boolean;
  /** SDK のモデル切替時の既定 thinking (setModel が上書きする値) */
  modelSwitchDefault: string;
  /** getBranch() が返す append-only の entry ログ */
  readonly entries: StubSessionEntry[];
  /** compaction を 1 回実行する (実 SDK と同じ順序でイベントと entry / messages を更新する) */
  compact(options?: StubCompactionOptions): Promise<void>;
  /** overflow 回復の再現: 失敗した assistant を agent state から外す (entry には残す) */
  dropLastAssistantFromState(): void;
}

/**
 * abort は進行中のチャンク遅延を中断し、prompt ループが巻き戻って agent_settled を自発的に発行する (実 SDK と同じ)。
 */
export function createStubSession(options: StubSessionOptions = {}): StubSession {
  const { reply = "スタブの返答です", chunkDelayMs = 0, setModelDelayMs = 0 } = options;
  const listeners = new Set<PiSessionEventListener>();
  // 実 SDK はリスナーへ message_end を配った後に SessionManager へ入れるため、その間だけ context が古い
  let historyUpdated = true;
  const sleepers = new Set<() => void>();
  const sleep = (ms: number) =>
    new Promise<void>((resolveSleep) => {
      if (ms <= 0) {
        resolveSleep();
        return;
      }
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolveSleep();
      };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      sleepers.add(wake);
    });

  // SessionManager と同じく append-only の entry ログを持ち、messages はそこから組み立てる。
  // compaction 後も圧縮前の entry を残す (実 SDK の getBranch() と同じ性質を再現する)。
  const entries: StubSessionEntry[] = [];
  let leafId: string | null = null;
  let entrySeq = 0;
  const appendEntry = (entry: Omit<StubSessionEntry, "id" | "parentId" | "timestamp">): StubSessionEntry => {
    entrySeq += 1;
    const created: StubSessionEntry = {
      ...entry,
      id: `entry-${entrySeq}`,
      parentId: leafId,
      timestamp: new Date().toISOString(),
    };
    entries.push(created);
    leafId = created.id;
    return created;
  };
  /** 最新の compaction だけを残す context 組み替え (buildContextEntries と同じ順序) */
  const contextEntries = (): StubSessionEntry[] => {
    let compactionIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index].type === "compaction") compactionIndex = index;
    }
    if (compactionIndex < 0) return [...entries];
    const kept: StubSessionEntry[] = [];
    let keeping = false;
    for (let index = 0; index < compactionIndex; index += 1) {
      if (!keeping && entries[index].id === entries[compactionIndex].firstKeptEntryId) keeping = true;
      if (keeping) kept.push(entries[index]);
    }
    return [entries[compactionIndex], ...kept, ...entries.slice(compactionIndex + 1)];
  };
  const contextMessages = (): PiSessionLike["messages"] =>
    contextEntries().flatMap((entry) => {
      if (entry.type === "message" && entry.message) return [entry.message];
      // 実 SDK と同じく role compactionSummary のメッセージが context の先頭に入る (BFF は payload から落とす)
      if (entry.type === "compaction") {
        return [
          {
            role: "compactionSummary",
            content: entry.summary ?? "",
            timestamp: Date.parse(entry.timestamp),
          },
        ];
      }
      return [];
    });

  const session = {
    sessionId: `pi-${Math.random().toString(36).slice(2, 10)}`,
    model: options.model ?? STUB_MODEL,
    // 実 SDK と同じく、作成時にもモデル能力へ補正する
    thinkingLevel: clampThinkingLevel(
      options.model ?? STUB_MODEL,
      (options.thinkingLevel ?? "low") as Parameters<typeof clampThinkingLevel>[1],
    ) as string,
    messages: [] as PiSessionLike["messages"],
    isStreaming: false,
    get isIdle() {
      return !session.isStreaming;
    },
    sessionManager: {
      getBranch: () => [...entries],
      getEntries: () => [...entries],
      appendModelChange: (provider: string, modelId: string) => {
        appendEntry({ type: "model_change", provider, modelId });
      },
    },
    get entries(): StubSessionEntry[] {
      return [...entries];
    },
    /** entry へ積むのと同時に agent state へも入れる (compaction では context の組み替えで置き換わる) */
    appendMessage(message: NonNullable<StubSessionEntry["message"]>): StubSessionEntry {
      const entry = appendEntry({ type: "message", message });
      session.messages.push(message);
      return entry;
    },
    supportsThinking: () => Boolean(session.model?.reasoning),
    getAvailableThinkingLevels: () => getSupportedThinkingLevels(session.model),
    // SDK と同様に非対応値をモデル能力へ補正する
    setThinkingLevel(level: string) {
      session.thinkingLevel = clampThinkingLevel(session.model, level as ThinkingLevel);
    },
    getContextUsage() {
      if (options.contextUsage === null) return undefined;
      const usage = options.contextUsage ?? STUB_CONTEXT_USAGE;
      const contextWindow = session.model?.contextWindow ?? usage.contextWindow;
      if (!historyUpdated && options.contextUsageBeforeHistory) {
        return { ...options.contextUsageBeforeHistory, contextWindow };
      }
      // 分母は実効モデルに合わせる (モデル切替後も整合させる)
      return { ...usage, contextWindow };
    },
    async setModel(model: unknown) {
      if (setModelDelayMs > 0) await sleep(setModelDelayMs);
      if ((options.setModelFailures ?? 0) > 0) {
        options.setModelFailures = (options.setModelFailures ?? 0) - 1;
        throw new Error("No API key for stub/model");
      }
      session.model = model as PiAiModel<Api>;
      // SDK は切替時にセッション既定の thinking を入れる (store 側の再適用を検証できる)
      session.thinkingLevel = session.modelSwitchDefault;
      appendEntry({ type: "model_change", provider: session.model?.provider, modelId: session.model?.id });
    },
    disposed: false,
    abortRequested: false,
    modelSwitchDefault: "medium",
    subscribe(listener: PiSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PiSessionEvent) {
      for (const listener of listeners) listener(event);
    },
    async abort() {
      if (!session.isStreaming) return;
      session.abortRequested = true;
      for (const wake of sleepers) wake();
    },
    dispose() {
      session.disposed = true;
    },
    dropLastAssistantFromState() {
      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        if (session.messages[index].role === "assistant") {
          session.messages.splice(index, 1);
          return;
        }
      }
    },
    async compact(compaction: StubCompactionOptions = {}) {
      const reason = compaction.reason ?? "threshold";
      const outcome = compaction.outcome ?? "ok";
      session.emit({ type: "compaction_start", reason });
      if (outcome !== "ok") {
        session.emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: outcome === "aborted",
          willRetry: false,
          ...(outcome === "error" ? { errorMessage: "Compaction failed: stub" } : {}),
        });
        return;
      }
      const displayable = contextEntries().filter(
        (entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"),
      );
      const summarizeCount = compaction.summarizeCount ?? Math.max(0, displayable.length - 2);
      const firstKept = displayable[Math.min(summarizeCount, displayable.length - 1)];
      let firstKeptEntryId: string | undefined = firstKept?.id;
      if (firstKept && compaction.firstKeptIsMetadata) {
        // 実 SDK の cut point は model 変更などの metadata entry を指し得る。
        // 境界の位置だけを再現したいので、branch の親子関係を保ったまま手前へ差し込む。
        entrySeq += 1;
        const metadata: StubSessionEntry = {
          type: "model_change",
          id: `entry-${entrySeq}`,
          parentId: firstKept.parentId,
          timestamp: new Date().toISOString(),
        };
        const position = entries.indexOf(firstKept);
        firstKept.parentId = metadata.id;
        entries.splice(position, 0, metadata);
        leafId = entries[entries.length - 1].id;
        firstKeptEntryId = metadata.id;
      }
      const tokensBefore = compaction.tokensBefore ?? 68_000;
      const entry = appendEntry({
        type: "compaction",
        summary: compaction.summary ?? "これまでの会話の要約です",
        firstKeptEntryId,
        tokensBefore,
        usage: compaction.usage,
        fromHook: compaction.fromHook,
      });
      session.messages = contextMessages();
      session.emit({
        type: "compaction_end",
        reason,
        result: {
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore,
          estimatedTokensAfter: compaction.estimatedTokensAfter ?? 5_000,
          usage: compaction.usage,
        },
        aborted: false,
        willRetry: false,
      });
    },
    async prompt(text: string, promptOptions?: { images?: Array<{ type: "image"; data: string; mimeType: string }> }) {
      session.abortRequested = false;
      session.isStreaming = true;
      try {
        // 実 SDK は送信メッセージを組み立てる前に preflight の compaction を走らせる
        const preflight = options.preflightCompactions?.shift();
        if (preflight) await session.compact(preflight);
        session.emit({ type: "agent_start" });
        // SDK と同じく、履歴に積む時点の時刻をメッセージへ持たせる (assistant は生成開始時刻)。
        // 実 SDK は prompt メッセージにも message_start / message_end を出し、message_end の時点で agent state へ入れる。
        const images = promptOptions?.images ?? [];
        const content = images.length > 0 ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text;
        const userMessage = { role: "user", content, timestamp: Date.now() };
        session.appendMessage(userMessage);
        session.emit({ type: "message_start", message: userMessage });
        session.emit({ type: "message_end", message: userMessage });
        session.emit({ type: "message_start", message: { role: "assistant" } });
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
          timestamp: Date.now(),
          // usage 非対応プロバイダを再現するときはキー自体を作らない
          ...(options.usage === null ? {} : { usage: options.usage ?? STUB_USAGE }),
        };
        session.appendMessage(assistant);
        if (options.thinkingDelta) {
          await sleep(chunkDelayMs);
          if (!session.abortRequested) {
            // SDK は thinking を content へ積むが、BFF が見るのは delta の有無だけ
            session.emit({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", delta: options.thinkingDelta },
            });
          }
        }
        const chunks = [reply.slice(0, 3), reply.slice(3)].filter(Boolean);
        for (const chunk of chunks) {
          await sleep(chunkDelayMs);
          if (session.abortRequested) break;
          (assistant.content[0] as { text: string }).text += chunk;
          session.emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: chunk },
          });
        }
        if (session.abortRequested) assistant.stopReason = "aborted";
        // SDK は確定したメッセージを agent state へ入れてから (同じ参照で) message_end を出す
        historyUpdated = false;
        try {
          session.emit({ type: "message_end", message: assistant });
        } finally {
          // 実 SDK はリスナーへ配信した後、同じターンで SessionManager へ追加する
          historyUpdated = true;
        }
      } finally {
        session.emit({ type: "agent_settled" });
        session.isStreaming = false;
      }
    },
  };
  if (options.sessionId) session.sessionId = options.sessionId;
  if (options.entries && options.entries.length > 0) {
    for (const entry of options.entries) entries.push(entry as StubSessionEntry);
    leafId = entries[entries.length - 1]?.id ?? null;
    entrySeq = entries.length;
    session.messages = contextMessages();
  }
  return session;
}

export interface StubCreateInput {
  agent?: AgentDef;
  skills?: SkillDef[];
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  /** rootCwd 相対の作業ディレクトリ (実ランタイムは絶対パスで受ける) */
  cwd?: string;
  sessionId?: string;
  entries?: unknown[];
  promptSnapshot?: { agent: string; skills: string[] };
}

export interface StubPiOptions {
  reply?: string;
  chunkDelayMs?: number;
  setModelDelayMs?: number;
  /** assistant へ載せる usage。null で usage 非対応プロバイダ (キー省略) を再現する */
  usage?: Usage | null;
  /** getContextUsage() の戻り値。null で SDK 非対応 (undefined を返す) を再現する */
  contextUsage?: ContextUsage | null;
  /** compaction 直後の再現: SDK が履歴へ入れるまで getContextUsage() が返す値 */
  contextUsageBeforeHistory?: ContextUsage;
  /** 最初の delta の前に送る thinking_delta の本文 (TTFT の検証用) */
  thinkingDelta?: string;
  /** 最初の N 回だけ setModel を失敗させる (ガード解除の検証用) */
  setModelFailures?: number;
  /** prompt ごとに消費する preflight compaction (StubSessionOptions と同じ) */
  preflightCompactions?: Array<StubCompactionOptions | null>;
  availableModels?: PiAiModel<Api>[];
  /** null を渡すとアプリ既定モデル無し (認証済み候補はある) を再現する */
  selectedModel?: PiAiModel<Api> | null;
  defaultThinkingLevel?: ThinkingLevel;
  defaultModelError?: string;
  availabilityError?: string;
  /** true で PI_MODELS が候補を全部落とした状態 (ready: false の whitelist 起因エラー) を再現する */
  modelWhitelistExcludesAll?: boolean;
  createSessionRejects?: number;
}

export function createStubPi(options: StubPiOptions = {}) {
  const available = options.availableModels ?? [STUB_MODEL, STUB_PLAIN_MODEL];
  const selectedModel = options.selectedModel === undefined ? available[0] : (options.selectedModel ?? undefined);
  const sessions: StubSession[] = [];
  const createInputs: StubCreateInput[] = [];
  return {
    cwd: "/tmp/project",
    selectedModel,
    availableModels: available,
    modelOptions: available.map(modelOptionOf),
    defaultThinkingLevel: options.defaultThinkingLevel ?? "medium",
    defaultModelError: options.defaultModelError,
    availabilityError: options.availabilityError,
    modelWhitelistExcludesAll: options.modelWhitelistExcludesAll ?? false,
    tools: ["read"],
    sessions,
    createInputs,
    resolveModel: (ref: ModelRef) => available.find((model) => model.provider === ref.provider && model.id === ref.id),
    createSession: async (input: StubCreateInput = {}) => {
      if ((options.createSessionRejects ?? 0) > 0) {
        options.createSessionRejects = (options.createSessionRejects ?? 0) - 1;
        const error = new Error(options.availabilityError ?? "Model is not available") as Error & {
          statusCode?: number;
        };
        error.statusCode = 503;
        throw error;
      }
      createInputs.push(input);
      const model = input.model
        ? available.find(
            (candidate) => candidate.provider === input.model?.provider && candidate.id === input.model?.id,
          )
        : selectedModel;
      if (input.model && !model) {
        const error = new Error(`Model is not available: ${input.model.provider}/${input.model.id}`) as Error & {
          statusCode?: number;
        };
        error.statusCode = 400;
        throw error;
      }
      if (!model) {
        const error = new Error(
          options.defaultModelError ?? options.availabilityError ?? "Model is not available",
        ) as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
      }
      const session = createStubSession({
        ...options,
        model,
        thinkingLevel: input.thinkingLevel ?? options.defaultThinkingLevel ?? "medium",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.entries ? { entries: input.entries } : {}),
      });
      sessions.push(session);
      return { session };
    },
  };
}

/** store が受ける PiBff の最小模倣であることを明示するためのキャスト */
export function asPiBff(pi: unknown): PiBff {
  return pi as PiBff;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}
