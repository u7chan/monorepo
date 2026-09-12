/**
 * テスト共通の pi ランタイム / セッションスタブ。実 API は呼ばず、createAgentSession() のイベントフロー
 * (subscribe / prompt / abort / agent_settled) を模倣し、thinkingLevel の能力判定と補正は SDK 公開ヘルパーをそのまま使う。
 */
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import type { PiBff } from "../src/agent";
import type { AgentDef, ModelOption, ModelRef, SkillDef, ThinkingLevel } from "../src/schema";
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

export interface StubSessionOptions {
  reply?: string;
  chunkDelayMs?: number;
  /** setModel を遅延させる (設定変更中の競合テスト用) */
  setModelDelayMs?: number;
  model?: PiAiModel<Api>;
  thinkingLevel?: string;
  /** 最初の N 回だけ setModel を失敗させる (ガード解除の検証用) */
  setModelFailures?: number;
}

export interface StubSession extends PiSessionLike {
  emit(event: PiSessionEvent): void;
  abortRequested: boolean;
  disposed: boolean;
  /** SDK のモデル切替時の既定 thinking (setModel が上書きする値) */
  modelSwitchDefault: string;
}

/**
 * abort は進行中のチャンク遅延を中断し、prompt ループが巻き戻って agent_settled を自発的に発行する (実 SDK と同じ)。
 */
export function createStubSession(options: StubSessionOptions = {}): StubSession {
  const { reply = "スタブの返答です", chunkDelayMs = 0, setModelDelayMs = 0 } = options;
  const listeners = new Set<PiSessionEventListener>();
  const sleepers = new Set<() => void>();
  const sleep = (ms: number) => new Promise<void>((resolveSleep) => {
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
  const session = {
    sessionId: `pi-${Math.random().toString(36).slice(2, 10)}`,
    model: options.model ?? STUB_MODEL,
    thinkingLevel: options.thinkingLevel ?? "low",
    messages: [] as Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string; timestamp?: number }>,
    isStreaming: false,
    get isIdle() {
      return !session.isStreaming;
    },
    supportsThinking: () => Boolean(session.model?.reasoning),
    getAvailableThinkingLevels: () => getSupportedThinkingLevels(session.model),
    // SDK と同様に非対応値をモデル能力へ補正する
    setThinkingLevel(level: string) {
      session.thinkingLevel = clampThinkingLevel(session.model, level as ThinkingLevel);
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
    },
    disposed: false,
    abortRequested: false,
    modelSwitchDefault: "medium",
    sessionManager: { getCwd: () => "/tmp/project" },
    subscribe(listener: PiSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PiSessionEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    async abort() {
      if (!session.isStreaming) return;
      session.abortRequested = true;
      for (const wake of [...sleepers]) wake();
    },
    dispose() {
      session.disposed = true;
    },
    async prompt(text: string) {
      session.abortRequested = false;
      session.isStreaming = true;
      try {
        // SDK と同じく、履歴に積む時点の時刻をメッセージへ持たせる (assistant は生成開始時刻)
        session.messages.push({ role: "user", content: text, timestamp: Date.now() });
        session.emit({ type: "agent_start" });
        session.emit({ type: "message_start", message: { role: "assistant" } });
        const assistant = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
          timestamp: Date.now(),
        };
        session.messages.push(assistant);
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
      } finally {
        session.emit({ type: "agent_settled" });
        session.isStreaming = false;
      }
    },
  };
  return session;
}

export interface StubCreateInput {
  agent?: AgentDef;
  skills?: SkillDef[];
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

export interface StubPiOptions {
  reply?: string;
  chunkDelayMs?: number;
  setModelDelayMs?: number;
  /** 最初の N 回だけ setModel を失敗させる (ガード解除の検証用) */
  setModelFailures?: number;
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
  const selectedModel = options.selectedModel === undefined
    ? available[0]
    : options.selectedModel ?? undefined;
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
    resolveModel: (ref: ModelRef) =>
      available.find((model) => model.provider === ref.provider && model.id === ref.id),
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
        ? available.find((candidate) => candidate.provider === input.model?.provider && candidate.id === input.model?.id)
        : selectedModel;
      if (input.model && !model) {
        const error = new Error(
          `Model is not available: ${input.model.provider}/${input.model.id}`,
        ) as Error & { statusCode?: number };
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
