/**
 * テスト共通の pi ランタイム / セッションスタブ。実 API は呼ばず、createAgentSession() のイベントフロー
 * (subscribe / prompt / abort / agent_settled) を模倣し、thinkingLevel の能力判定と補正は SDK 公開ヘルパーをそのまま使う。
 */
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model as PiAiModel } from "@earendil-works/pi-ai";
import type { ModelCatalogRefreshAttempt, PiBff } from "../src/agent";
import type { ModelSelection } from "../src/agent";
import { MODEL_UNSET_MESSAGE } from "../src/agent";
import type { AskUserHost } from "../src/ask-user-tool";
import type { ContentGenerationConfig } from "../src/images";
import type { InvestigateHost } from "../src/investigate-tool";
import type { ServeToolHost } from "../src/serve-tool";
import type { WebSearchRuntimeConfig } from "../src/web-search-tool";
import type { SessionEnvSource } from "../src/agent";
import { createMutableSecretMasker } from "../src/redact";
import type {
  AgentDef,
  AgentSkillInfo,
  ContextUsage,
  ModelOption,
  ModelRef,
  RuntimeModelsResponse,
  SkillDef,
  ThinkingLevel,
  Usage,
} from "../src/schema";
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
  /** BFF からの手動 compaction (引数なしの compact()) に使う options */
  manualCompaction?: StubCompactionOptions;
  /**
   * BFF からの手動 compaction に使う options の列。呼び出しごとに先頭から 1 件消費し、尽きたら
   * `manualCompaction` へ戻る。成功と失敗を 1 つの fixture で順に見るために使う
   */
  manualCompactions?: StubCompactionOptions[];
  /**
   * 本文キーワードで起こす preflight (自動) compaction。option 未設定なら完全に no-op。
   * キーワードは既存のトリガー (`連続ツール` / `畳み窓` / investigate の依頼文) と衝突しない語にする
   */
  preflightCompaction?: StubKeywordCompaction;
  /**
   * investigate の呼び出しと進捗。実モデルの代わりに、prompt 中へ tool_execution_start →
   * tool_execution_update ×N → tool_execution_end を流し、live 行の配信経路だけを再現する
   */
  investigateProgress?: StubInvestigateProgress;
  /**
   * 連続するツール呼び出し (ライブ表示の受入用)。速い順次と並列を実 SDK と同じ順序で流す。
   * 本文 (reply) は最後の呼び出しの後に流すため、本文が出ている間にホールドと畳みが見える。
   * 配列で渡すと prompt ごとに 1 つ選ぶ (最初に一致したものだけ流す)
   */
  toolBurst?: StubToolBurst | StubToolBurst[];
  /**
   * prompt が user message を履歴へ積む前に失敗する (認証エラー等)。BFF は user entry の無いまま
   * error で終端するため、受理済みの送信が未送信として残る経路を再現できる
   */
  promptFailureBeforeUser?: string;
  /**
   * `promptFailureBeforeUser` を失敗させる回数 (未指定は毎回)。1 で「1 回目だけ user message を
   * 積む前に失敗させ、同じ run id の再送は通常どおり走らせる」を再現できる
   */
  promptFailuresBeforeUser?: number;
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
    /** role "toolResult" のとき: 対応する toolCall の id と成否 */
    toolCallId?: string;
    isError?: boolean;
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

/** 本文キーワードで起こす preflight (自動) compaction */
export interface StubKeywordCompaction {
  /** この語を本文に含む送信のときだけ、user message を積む前に流す */
  prompt: string;
  /** compact() へ渡す options。省略は既定 (reason は threshold = 自動) */
  compaction?: StubCompactionOptions;
}

/** investigate の進捗を模す。progress の各要素が 1 回の tool_execution_update になる */
export interface StubInvestigateProgress {
  /** モデルが渡す依頼文 (ツールカードの引数になる) */
  prompt?: string;
  /** 子の進捗。runner と同じく「現在の活動」と「本文末尾」を 1 本の本文へ詰めて流す */
  progress?: string[];
  /** tool_execution_end の報告本文 */
  result?: string;
  toolCallId?: string;
}

/** 連続するツール呼び出し。at / endAt が同じ呼び出しは並列になる */
export interface StubToolBurst {
  /** この語を本文に含む送信のときだけ流す (省略すると常に) */
  prompt?: string;
  calls?: StubToolBurstCall[];
  /**
   * 最後のツール (investigate) が終わった後に届く一瞬の行。start と end を同じ時刻で流すため、
   * 実行中として一度も出ず、ホールドだけが積まれる。畳みはじめの窓へ入れて受入に使う
   */
  closingWindow?: StubToolBurstClosingRow;
}

export interface StubToolBurstClosingRow {
  /** 最後のツールが終わってから流すまでの待ち (ms)。畳みの時間の中へ入れる */
  afterMs?: number;
  name?: string;
  args?: unknown;
  result?: string;
}

/** 送信本文に合う burst を 1 つ選ぶ (prompt 省略は常に一致。配列の先頭から見る) */
function stubToolBurstOf(option: StubToolBurst | StubToolBurst[] | undefined, text: string): StubToolBurst | undefined {
  const bursts = option === undefined ? [] : Array.isArray(option) ? option : [option];
  return bursts.find((burst) => burst.prompt === undefined || text.includes(burst.prompt));
}

export interface StubToolBurstCall {
  name?: string;
  /** SDK が渡す引数。`toolArgsSummary` が command / path を拾い、それ以外は JSON になる */
  args?: unknown;
  /** tool_execution_start を出す時刻 (prompt 開始からの相対 ms) */
  at?: number;
  /** tool_execution_end を出す時刻。省略すると at と同じ (一瞬で終わるツール) */
  endAt?: number;
  /** investigate と同じ子の進捗 (start と end の間に等間隔で流す) */
  progress?: string[];
  /** tool_execution_end の報告本文 */
  result?: string;
}

type StubToolBurstEvent = {
  at: number;
  id: string;
  kind: "start" | "update" | "end";
  call: StubToolBurstCall;
  text?: string;
};

const BURST_KIND_ORDER: Record<StubToolBurstEvent["kind"], number> = { start: 0, update: 1, end: 2 };

/** burst を時刻順のイベント列へ潰す。同じ時刻の start が並列になり、進捗は start と end の間へ均す */
function toolBurstTimeline(calls: StubToolBurstCall[], idPrefix: string): StubToolBurstEvent[] {
  const events: StubToolBurstEvent[] = [];
  calls.forEach((call, index) => {
    const id = `${idPrefix}${index + 1}`;
    const at = call.at ?? 0;
    const endAt = Math.max(at, call.endAt ?? at);
    const progress = call.progress ?? [];
    events.push({ at, id, kind: "start", call });
    progress.forEach((text, line) => {
      events.push({
        at: Math.round(at + ((endAt - at) * (line + 1)) / (progress.length + 1)),
        id,
        kind: "update",
        call,
        text,
      });
    });
    events.push({ at: endAt, id, kind: "end", call });
  });
  return events.sort((a, b) => a.at - b.at || BURST_KIND_ORDER[a.kind] - BURST_KIND_ORDER[b.kind]);
}

/** burst のツール名 (未指定は読み取り) */
function toolBurstName(call: StubToolBurstCall): string {
  return call.name ?? "read";
}

export interface StubCompactionOptions {
  reason?: "manual" | "threshold" | "overflow";
  /** 先頭から何件の表示メッセージを要約へ置き換えるか。未指定は最後の 2 件を残す */
  summarizeCount?: number;
  /** "none" / "aborted" / "error" で result が無い異常系を再現する */
  outcome?: "ok" | "none" | "aborted" | "error";
  /**
   * "too-small" で `Nothing to compact (session too small)`、"already" で `Already compacted`、
   * "unknown" で未知の例外を compaction_end の後に投げる (実 SDK と同じ順序)
   */
  failure?: "too-small" | "already" | "unknown";
  /** 要約生成の待ち (ms)。圧縮中の abort / delete / close の検証に使う */
  delayMs?: number;
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
  /** entry へ積むのと同時に agent state (messages) へも入れる (SDK の append と同じ参照を保つ) */
  appendMessage(message: NonNullable<StubSessionEntry["message"]>): StubSessionEntry;
  abortRequested: boolean;
  disposed: boolean;
  /** SDK のモデル切替時の既定 thinking (setModel が上書きする値) */
  modelSwitchDefault: string;
  /** getBranch() が返す append-only の entry ログ */
  readonly entries: StubSessionEntry[];
  /** BFF からの手動呼び出しは customInstructions (string)、テストからの呼び出しは options */
  compact(customInstructions?: string): Promise<unknown>;
  compact(options?: StubCompactionOptions): Promise<void>;
  /** compaction 中に届いた abortCompaction / abort の回数 */
  compactionAborts: number;
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
  // 実 SDK の isCompacting / abortCompaction に対応する状態 (BFF の保存待ちは含まない)
  let compacting = false;
  // 呼び出し id は prompt ごとに変える。ライブ表示は同じ id を再び観測した行を「復元カード」とみなして
  // 畳む対象から外すため、同じ id を使い回すと 2 回目以降の行がホールドされない (fixture の再実行で必要)
  let promptSeq = 0;
  let compactionAbortRequested = false;
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
    /** 手動 / 自動 compaction の実行中 (実 SDK と同じく isIdle へも効く) */
    get isCompacting() {
      return compacting;
    },
    get isIdle() {
      return !session.isStreaming && !compacting;
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
      // 実 SDK の abort() は compaction も中止して idle を待つ。BFF の stop もこれを流用する
      session.abortCompaction();
      if (!session.isStreaming) return;
      session.abortRequested = true;
      for (const wake of sleepers) wake();
    },
    compactionAborts: 0,
    abortCompaction() {
      if (!compacting) return;
      compactionAbortRequested = true;
      session.compactionAborts += 1;
      // 要約生成の待ちを起こして、compact() の巻き戻しを進める
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
    /**
     * BFF (手動圧縮) は customInstructions の string で、テストは StubCompactionOptions の object で呼ぶ。
     * 実 SDK と同じ順序 (compaction_start → 負荷 → entry append → compaction_end → 例外) を再現する。
     */
    async compact(instructionsOrOptions?: string | StubCompactionOptions) {
      const fromBff = instructionsOrOptions === undefined || typeof instructionsOrOptions === "string";
      const compaction: StubCompactionOptions = fromBff
        ? (options.manualCompactions?.shift() ?? options.manualCompaction ?? {})
        : instructionsOrOptions;
      // 手動 (BFF / 文字列) は manual、テストの object 指定は従来どおり threshold を既定にする
      const reason = compaction.reason ?? (fromBff ? "manual" : "threshold");
      const outcome = compaction.outcome ?? "ok";
      compacting = true;
      session.emit({ type: "compaction_start", reason });
      try {
        if ((compaction.delayMs ?? 0) > 0) await sleep(compaction.delayMs ?? 0);
        if (compactionAbortRequested) {
          session.emit({
            type: "compaction_end",
            reason,
            result: undefined,
            aborted: true,
            willRetry: false,
          });
          throw new Error("Compaction cancelled");
        }
        if (compaction.failure) {
          const message =
            compaction.failure === "too-small"
              ? "Nothing to compact (session too small)"
              : compaction.failure === "already"
                ? "Already compacted"
                : "stub compaction exploded";
          session.emit({
            type: "compaction_end",
            reason,
            result: undefined,
            aborted: false,
            willRetry: false,
            errorMessage: `Compaction failed: ${message}`,
          });
          throw new Error(message);
        }
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
          (entry) =>
            entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"),
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
      } finally {
        compacting = false;
        compactionAbortRequested = false;
      }
    },
    async prompt(text: string) {
      session.abortRequested = false;
      session.isStreaming = true;
      let failedBeforeUser = false;
      try {
        // 実 SDK は送信メッセージを組み立てる前に失敗し得る (認証エラー等)。user entry を積まない
        if (options.promptFailureBeforeUser && (options.promptFailuresBeforeUser ?? Number.POSITIVE_INFINITY) > 0) {
          if (options.promptFailuresBeforeUser !== undefined) options.promptFailuresBeforeUser -= 1;
          failedBeforeUser = true;
          throw new Error(options.promptFailureBeforeUser);
        }
        // 実 SDK は送信メッセージを組み立てる前に preflight の compaction を走らせる
        const preflight = options.preflightCompactions?.shift();
        if (preflight) await session.compact(preflight);
        // 本文キーワードで起こす自動 compaction (option 未設定なら完全に no-op)。実 SDK と同じく
        // user message を積む前なので、区切りはこの送信の手前に位置する
        const keywordCompaction = options.preflightCompaction;
        if (keywordCompaction && text.includes(keywordCompaction.prompt)) {
          await session.compact(keywordCompaction.compaction ?? {});
        }
        session.emit({ type: "agent_start" });
        // SDK と同じく、履歴に積む時点の時刻をメッセージへ持たせる (assistant は生成開始時刻)。
        // 実 SDK は prompt メッセージにも message_start / message_end を出し、message_end の時点で agent state へ入れる。
        const userMessage = { role: "user", content: text, timestamp: Date.now() };
        session.appendMessage(userMessage);
        session.emit({ type: "message_start", message: userMessage });
        session.emit({ type: "message_end", message: userMessage });
        session.emit({ type: "message_start", message: { role: "assistant" } });
        // investigate の呼び出しを模す (live 行の配信経路を作る)。tool_end は本文の後で出す
        promptSeq += 1;
        const investigate = options.investigateProgress;
        const investigateToolCallId = investigate?.toolCallId ?? `call-investigate-${promptSeq}`;
        const burstIdPrefix = `call-burst-${promptSeq}-`;
        const investigateArgs = { prompt: investigate?.prompt ?? "スタブの調査依頼" };
        if (investigate) {
          session.emit({
            type: "tool_execution_start",
            toolCallId: investigateToolCallId,
            toolName: "investigate",
            args: investigateArgs,
          });
        }
        // 連続ツール呼び出しも同じく呼び出しだけ先に知らせ、end は本文の後で出す
        const burst = stubToolBurstOf(options.toolBurst, text);
        const burstCalls = burst?.calls ?? [];
        const burstEvents = toolBurstTimeline(burstCalls, burstIdPrefix);
        const closingRow = burst?.closingWindow;
        const closingToolCallId = `${burstIdPrefix}tail`;
        const closingToolName = closingRow?.name ?? "bash";
        const closingArgs = closingRow?.args ?? {};
        // 実 SDK と同じく toolCall は assistant の本文へ入る (リロード後もカードが履歴から復元される)
        const assistantText = { type: "text", text: "" };
        const assistant = {
          role: "assistant",
          content: [
            ...(investigate
              ? [{ type: "toolCall", id: investigateToolCallId, name: "investigate", arguments: investigateArgs }]
              : []),
            ...burstCalls.map((call, index) => ({
              type: "toolCall",
              id: `${burstIdPrefix}${index + 1}`,
              name: toolBurstName(call),
              arguments: call.args ?? {},
            })),
            ...(closingRow
              ? [{ type: "toolCall", id: closingToolCallId, name: closingToolName, arguments: closingArgs }]
              : []),
            assistantText,
          ],
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
        // 子の進捗 (tool_execution_update) を本文の前に流す。間隔は本文 delta と同じ chunkDelayMs に合わせる
        for (const text of investigate?.progress ?? []) {
          await sleep(chunkDelayMs);
          if (session.abortRequested) break;
          session.emit({
            type: "tool_execution_update",
            toolCallId: investigateToolCallId,
            toolName: "investigate",
            args: investigateArgs,
            partialResult: { content: [{ type: "text", text }] },
          });
        }
        const chunks = [reply.slice(0, 3), reply.slice(3)].filter(Boolean);
        // 連続ツール呼び出しを時刻どおりに流す (速い順次と並列を同じタイムラインで再現する)
        let burstAt = 0;
        for (const event of burstEvents) {
          await sleep(event.at - burstAt);
          burstAt = event.at;
          if (session.abortRequested) break;
          const toolCallId = event.id;
          const toolName = toolBurstName(event.call);
          const args = event.call.args ?? {};
          if (event.kind === "start") {
            session.emit({ type: "tool_execution_start", toolCallId, toolName, args });
            continue;
          }
          if (event.kind === "update") {
            session.emit({
              type: "tool_execution_update",
              toolCallId,
              toolName,
              args,
              partialResult: { content: [{ type: "text", text: event.text ?? "" }] },
            });
            continue;
          }
          const resultText = event.call.result ?? `${toolName} の結果`;
          session.emit({
            type: "tool_execution_end",
            toolCallId,
            toolName,
            isError: false,
            result: { content: [{ type: "text", text: resultText }] },
          });
          // 実 SDK と同じく toolResult も履歴へ積む (履歴のカードはこのメッセージから投影される)
          session.appendMessage({
            role: "toolResult",
            content: [{ type: "text", text: resultText }],
            toolCallId,
            isError: false,
            timestamp: Date.now(),
          });
        }
        for (const chunk of chunks) {
          await sleep(chunkDelayMs);
          if (session.abortRequested) break;
          assistantText.text += chunk;
          session.emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: chunk },
          });
        }
        if (session.abortRequested) assistant.stopReason = "aborted";
        if (investigate && !session.abortRequested) {
          const resultText = investigate.result ?? "スタブの調査結果";
          session.emit({
            type: "tool_execution_end",
            toolCallId: investigateToolCallId,
            toolName: "investigate",
            isError: false,
            result: {
              content: [{ type: "text", text: resultText }],
              details: { outcome: "completed", toolCalls: (investigate.progress ?? []).length },
            },
          });
          // 実 SDK と同じく toolResult も履歴へ積む (履歴のカードはこのメッセージから投影される)
          session.appendMessage({
            role: "toolResult",
            content: [{ type: "text", text: resultText }],
            toolCallId: investigateToolCallId,
            isError: false,
            timestamp: Date.now(),
          });
        }
        // 畳みはじめの窓の再現: 最後のツールが終わった後、箱が畳みはじめた頃に start と end が同じ時刻の
        // 行を 1 本だけ流す (実行中として出ないため、900ms のホールドが積まれなければ読めない)
        if (closingRow && !session.abortRequested) {
          await sleep(closingRow.afterMs ?? 100);
          const resultText = closingRow.result ?? `${closingToolName} の結果`;
          session.emit({
            type: "tool_execution_start",
            toolCallId: closingToolCallId,
            toolName: closingToolName,
            args: closingArgs,
          });
          session.emit({
            type: "tool_execution_end",
            toolCallId: closingToolCallId,
            toolName: closingToolName,
            isError: false,
            result: { content: [{ type: "text", text: resultText }] },
          });
          // 実 SDK と同じく toolResult も履歴へ積む (履歴のカードはこのメッセージから投影される)
          session.appendMessage({
            role: "toolResult",
            content: [{ type: "text", text: resultText }],
            toolCallId: closingToolCallId,
            isError: false,
            timestamp: Date.now(),
          });
        }
        // SDK は確定したメッセージを agent state へ入れてから (同じ参照で) message_end を出す
        historyUpdated = false;
        try {
          session.emit({ type: "message_end", message: assistant });
        } finally {
          // 実 SDK はリスナーへ配信した後、同じターンで SessionManager へ追加する
          historyUpdated = true;
        }
      } finally {
        // user message を積む前の失敗 (認証エラー等) は agent が開始していないため settled を出さない。
        // BFF は prompt() の reject で run を error として終端する。回数制限で失敗を抜けた試行は
        // 通常どおり settled を出す (再送の検証で 1 回目の失敗だけを再現する)
        if (!failedBeforeUser) session.emit({ type: "agent_settled" });
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
  /** セッションのエージェントスナップショット (スタブでは使わない) */
  agentSkills?: AgentSkillInfo[];
  /** 子モード (investigate の子セッション)。呼び出し側の検証用に記録するだけ */
  mode?: "chat" | "investigation";
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
  /** BFF からの手動 compaction (引数なしの compact()) に使う options */
  manualCompaction?: StubCompactionOptions;
  /** 呼び出しごとに 1 件消費する手動 compaction の options (StubSessionOptions と同じ) */
  manualCompactions?: StubCompactionOptions[];
  /** 本文キーワードで起こす preflight (自動) compaction (StubSessionOptions と同じ) */
  preflightCompaction?: StubKeywordCompaction;
  /** investigate の live 行を fixture で見るための進捗 (StubSessionOptions と同じ) */
  investigateProgress?: StubInvestigateProgress;
  /** 連続するツール呼び出しの live 受入 (StubSessionOptions と同じ) */
  toolBurst?: StubToolBurst | StubToolBurst[];
  /** prompt が user message を積む前に失敗する (StubSessionOptions と同じ) */
  promptFailureBeforeUser?: string;
  /** `promptFailureBeforeUser` を失敗させる回数 (StubSessionOptions と同じ) */
  promptFailuresBeforeUser?: number;
  availableModels?: PiAiModel<Api>[];
  /** モデルカタログ (設定 → モデルのモデル一覧表示と診断が使う) */
  catalogModels?: PiAiModel<Api>[];
  /** null を渡すとアプリ既定モデル無し (認証済み候補はある) を再現する */
  selectedModel?: PiAiModel<Api> | null;
  defaultThinkingLevel?: ThinkingLevel;
  defaultModelError?: string;
  /** true で「アプリ既定モデルが未設定 (候補はある)」を再現する */
  defaultModelUnset?: boolean;
  availabilityError?: string;
  /** true で許可リストが候補を全部落とした状態 (ready: false の許可リスト起因エラー) を再現する */
  modelWhitelistExcludesAll?: boolean;
  /** GET /api/runtime/models が返すカタログを直接与える (未指定は undefined = 503) */
  modelCatalog?: RuntimeModelsResponse;
  /**
   * カタログ更新の SDK 面の模倣。throw すると例外経路、`aborted` / `failedProviders` で失敗分類を検証できる。
   * 取得に成功した見せかけは `setModelCatalog()` で新しい一覧へ差し替える。
   */
  onRefreshModelCatalog?: (options: {
    allowNetwork: boolean;
    force: boolean;
    signal: AbortSignal;
  }) => ModelCatalogRefreshAttempt | Promise<ModelCatalogRefreshAttempt>;
  createSessionRejects?: number;
  /** 設定 → モデルの API が返すプロバイダー。省略時は stub 1 件 (キー登録可) */
  providers?: StubProvider[];
  /** テストからツールする SDK 操作の模倣。throw すると CredentialCommit の分類を検証できる */
  onSetRuntimeApiKey?: (provider: string, apiKey: string, signal: AbortSignal | undefined) => Promise<void> | void;
  onRemoveRuntimeApiKey?: (provider: string, signal: AbortSignal | undefined) => Promise<void> | void;
}

export interface StubProvider {
  provider: string;
  name?: string;
  canSetApiKey?: boolean;
  supportsOAuth?: boolean;
  /** configured の初期値。false (既定) は未認証 */
  configured?: boolean;
  authSource?: string;
}

/** 設定 → モデルの API 用。認証変更の呼び出しを記録し、provider ごとの configured を書き換える */
export interface StubModelRuntimeCall {
  operation: "setRuntimeApiKey" | "removeRuntimeApiKey";
  provider: string;
  apiKey?: string;
}

/** カタログ更新の SDK 呼び出し。実 SDK へ渡す契約 (allowNetwork / force) と呼び出し時の signal を記録する */
export interface StubCatalogRefreshCall {
  allowNetwork: boolean;
  force: boolean;
  aborted: boolean;
  /** 取得に渡された期限。状態再計算へ同じ期限が伝わっているかの検証に使う */
  signal: AbortSignal;
}

export interface StubModelRuntime {
  getProviders(): readonly { id: string; name: string; auth: { apiKey?: { login: unknown }; oauth: unknown } }[];
  getModels(): readonly PiAiModel<Api>[];
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string } | undefined;
  setRuntimeApiKey(provider: string, apiKey: string, options?: { signal?: AbortSignal }): Promise<void>;
  removeRuntimeApiKey(provider: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export function createStubModelRuntime(
  options: StubPiOptions = {},
  calls: StubModelRuntimeCall[] = [],
): StubModelRuntime {
  const configured = new Map<string, boolean>(
    (options.providers ?? []).map((provider) => [provider.provider, provider.configured ?? false]),
  );
  return {
    getProviders: () =>
      (options.providers ?? []).map((provider) => ({
        id: provider.provider,
        name: provider.name ?? provider.provider,
        auth: {
          apiKey: provider.canSetApiKey === false ? undefined : { login: () => {} },
          oauth: provider.supportsOAuth ? {} : undefined,
        },
      })),
    getModels: () => options.catalogModels ?? [],
    getProviderAuthStatus: (provider) => {
      const entry = (options.providers ?? []).find((candidate) => candidate.provider === provider);
      if (!entry) return { configured: false };
      return configured.get(provider)
        ? { configured: true, source: entry.authSource ?? "environment" }
        : { configured: false };
    },
    setRuntimeApiKey: async (provider, apiKey, callOptions) => {
      calls.push({ operation: "setRuntimeApiKey", provider, apiKey });
      await options.onSetRuntimeApiKey?.(provider, apiKey, callOptions?.signal);
      configured.set(provider, true);
    },
    removeRuntimeApiKey: async (provider, callOptions) => {
      calls.push({ operation: "removeRuntimeApiKey", provider });
      await options.onRemoveRuntimeApiKey?.(provider, callOptions?.signal);
      configured.set(provider, false);
    },
  };
}

export function createStubPi(options: StubPiOptions = {}) {
  const available = options.availableModels ?? [STUB_MODEL, STUB_PLAIN_MODEL];
  const selectedModel = options.selectedModel === undefined ? available[0] : (options.selectedModel ?? undefined);
  const sessions: StubSession[] = [];
  const createInputs: StubCreateInput[] = [];
  // 設定 → モデル用の記録。bootstrap がメソッドを剥ぎ取っても動くよう、配列はクロージャで持つ
  const modelRuntimeCalls: StubModelRuntimeCall[] = [];
  const catalogRefreshCalls: StubCatalogRefreshCall[] = [];
  // refresh 成功でカタログが差し替わる様子を再現できるよう、GET が読む値を可変にする
  const catalogHolder: { value: RuntimeModelsResponse | undefined } = { value: options.modelCatalog };
  const retainedSecrets: string[] = [];
  const secretMasker = createMutableSecretMasker([]);
  // setter が refresh より先に呼ばれることを順序で確かめられるよう、同じログへ積む
  const modelStateEvents: string[] = [];
  // 取得と再計算が同じ期限を共有すること (signal が同一オブジェクトか) を検証できるようにする
  const modelStateRefreshSignals: (AbortSignal | undefined)[] = [];
  const modelSelections: ModelSelection[] = [];
  const contentGenerationConfigs: ContentGenerationConfig[] = [];
  const webSearchConfigs: WebSearchRuntimeConfig[] = [];
  // serve ツールの実体 (bootstrap が注入する)。ツールの配線はここに記録して検証する
  const serveHosts: ServeToolHost[] = [];
  // ask_user ツールの実体 (bootstrap が注入する)。待機の所有は実物と同じく store 側にある
  const askUserHosts: AskUserHost[] = [];
  // investigate ツールの実体 (bootstrap が注入する)。子は record に載らないので、記録するだけ
  const investigateHosts: InvestigateHost[] = [];
  // 環境変数 (作業環境 → 環境変数) の解決源。bootstrap が注入する
  const sessionEnvs: SessionEnvSource[] = [];
  let refreshCount = 0;
  return {
    cwd: "/tmp/project",
    selectedModel,
    availableModels: available,
    modelOptions: available.map(modelOptionOf),
    defaultThinkingLevel: options.defaultThinkingLevel ?? "medium",
    defaultModelError: options.defaultModelError,
    defaultModelUnset: options.defaultModelUnset ?? false,
    availabilityError: options.availabilityError,
    modelWhitelistExcludesAll: options.modelWhitelistExcludesAll ?? false,
    get modelCatalog() {
      return catalogHolder.value;
    },
    setModelCatalog: (next: RuntimeModelsResponse | undefined) => {
      catalogHolder.value = next;
    },
    tools: ["read"],
    sessions,
    createInputs,
    // 設定 → モデル (bootstrap の createProviderKeyRuntime) が触る SDK 面の模倣
    modelRuntime: createStubModelRuntime(options, modelRuntimeCalls),
    modelRuntimeCalls,
    // 実物と同じく、retainSecret で保護対象が増える可変マスカーを返す
    secretMasker,
    retainedSecrets,
    modelSelections,
    modelStateEvents,
    // 画像生成の注入面（bootstrap が AppDb.open 後に写す）。記録だけしてセッション作成には使わない
    contentGenerationConfigs,
    get contentGenerationEnabled() {
      return contentGenerationConfigs.at(-1)?.enabled === true;
    },
    setContentGeneration: (config: ContentGenerationConfig) => {
      contentGenerationConfigs.push(config);
    },
    webSearchConfigs,
    // 注入のたびに差し替わる。実行中のセッションが同じ関数を読むことを再現する
    setWebSearch: (config: WebSearchRuntimeConfig) => {
      webSearchConfigs.push(config);
    },
    serveHosts,
    setServe: (host: ServeToolHost) => {
      serveHosts.push(host);
    },
    askUserHosts,
    setAskUser: (host: AskUserHost) => {
      askUserHosts.push(host);
    },
    investigateHosts,
    setInvestigate: (host: InvestigateHost) => {
      investigateHosts.push(host);
    },
    sessionEnvs,
    setSessionEnv: (source: SessionEnvSource) => {
      sessionEnvs.push(source);
    },
    retainSecret: (value: string) => {
      retainedSecrets.push(value);
      secretMasker.setSecrets(retainedSecrets);
    },
    get refreshCount() {
      return refreshCount;
    },
    setModelSelection: (selection: ModelSelection) => {
      modelStateEvents.push("set");
      modelSelections.push(selection);
    },
    refreshModelState: async (refreshOptions: { signal?: AbortSignal } = {}) => {
      modelStateEvents.push("refresh");
      refreshCount += 1;
      modelStateRefreshSignals.push(refreshOptions.signal);
    },
    modelStateRefreshSignals,
    // カタログ更新 (bootstrap の createProviderKeyRuntime) が触る SDK 面の模倣。
    // 実 SDK の refresh と同じく、呼び出し時の signal が既に abort 済みなら即座に aborted で返す。
    refreshModelCatalog: async (refreshOptions: { allowNetwork: boolean; force: boolean; signal: AbortSignal }) => {
      catalogRefreshCalls.push({
        allowNetwork: refreshOptions.allowNetwork,
        force: refreshOptions.force,
        aborted: refreshOptions.signal.aborted,
        signal: refreshOptions.signal,
      });
      if (refreshOptions.signal.aborted) return { aborted: true, failedProviders: 0 };
      return options.onRefreshModelCatalog
        ? options.onRefreshModelCatalog(refreshOptions)
        : { aborted: false, failedProviders: 0 };
    },
    catalogRefreshCalls,
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
          options.defaultModelError ??
            options.availabilityError ??
            (options.defaultModelUnset ? MODEL_UNSET_MESSAGE : "Model is not available"),
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
