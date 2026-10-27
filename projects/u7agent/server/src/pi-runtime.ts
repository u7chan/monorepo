/**
 * pi SDK の型が BFF の用途に合わない箇所を埋める互換層。SDK のイベント・SessionEntry・
 * AgentSession のうち BFF が使う分だけを写し、スタブや旧 SDK でも動くよう欠けたフィールドを許す。
 */
import type { AgentDef, ContextUsage, ModelRef, ThinkingLevel, Usage } from "./schema";
import type { PromptSnapshot } from "./session-store";
import { ContextUsageSchema, UsageSchema } from "./schema";

/** compaction_end の result (SDK の CompactionResult のうち BFF が控える分) */
export interface PiCompactionResult {
  estimatedTokensAfter?: unknown;
}

/** message_start / message_end で届くメッセージ (BFF が読むフィールドだけ) */
export interface PiSessionMessageLike {
  role?: string;
  content?: unknown;
  /** 生成に使ったモデル。usage と同じく、報告しない SDK / スタブでは欠ける */
  provider?: string;
  model?: string;
  /** ログの時刻。SDK は epoch ms (number) で、旧 SDK・スタブでは欠ける / 別型もあり得る */
  timestamp?: unknown;
  stopReason?: string;
  usage?: unknown;
}

/** pi SDK から届くランタイムイベントの緩い形 (必要なフィールドのみ) */
export interface PiSessionEvent {
  type?: string;
  message?: PiSessionMessageLike | null;
  assistantMessageEvent?: { type?: string; delta?: string } | null;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  /** tool_execution_update: ツールが onUpdate へ渡した途中結果 (live 表示に使う investigate の進捗) */
  partialResult?: unknown;
  isError?: boolean;
  result?: unknown;
  /** auto_retry_start: SDK が現在の連続失敗系列へ付けた番号と待機幅 */
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  /** auto_retry_end: 系列の成否。待機終了の通知ではない */
  success?: boolean;
  finalError?: string;
  error?: unknown;
  willRetry?: boolean;
  reason?: string;
  aborted?: boolean;
  errorMessage?: string;
  /** entry_appended: SDK が追記した entry (context_edit の検知だけに使う) */
  entry?: { type?: string } | null;
}

/** pi SDK の SessionEntry (BFF が compaction を読むのに必要な分だけ) */
export interface PiSessionEntryLike {
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  message?: { role?: unknown; content?: unknown } | null;
  summary?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  usage?: unknown;
  fromHook?: unknown;
}

export type PiSessionEventListener = (event: PiSessionEvent) => void;

/** pi SDK の AgentSession を差し替え可能にするための最小 interface */
export interface PiSessionLike {
  sessionId: string;
  model?: { provider: string; id: string } | null;
  thinkingLevel?: string;
  messages: Array<{
    role: string;
    content: unknown;
    stopReason?: string;
    errorMessage?: string;
    timestamp?: number;
    usage?: unknown;
    /** SDK の AssistantMessage が持つ生成元モデル。旧 SDK・スタブでは欠ける */
    provider?: string;
    model?: string;
    /** SDK が記録した応答 / ツール実行の所要時間。0 を取り得るので、0 は未記録として扱う */
    durationMs?: number;
    /** role "toolResult" のとき: 対応する toolCall の id と成否 (スキル読み込みの導出に使う) */
    toolCallId?: string;
    isError?: boolean;
    /** role "toolResult" のとき: ツールが返した構造化データ (ask_user の質問 / 回答の復元に使う) */
    details?: unknown;
  }>;
  isStreaming: boolean;
  /** SDK の isIdle (実行・compaction・retry が無い) */
  isIdle: boolean;
  /**
   * SDK の steering モード。`"all"` は実キューを次のモデル判断の前に全件注入する。
   * 旧 SDK はこの設定を持たない (undefined) ため、BFF は 1 件ずつの配送に留める
   */
  steeringMode?: "all" | "one-at-a-time";
  subscribe(listener: PiSessionEventListener): () => void;
  prompt(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
  /**
   * SDK の Agent。実キューへの残存確認だけに使い、取消の成否は `peekQueuedMessages()` で判定する
   * (表示用ミラーや private フィールドには依存しない)。スタブ・旧 SDK では欠けてもよい
   */
  agent?: {
    peekQueuedMessages(): unknown[];
    hasQueuedMessages?(): boolean;
  };
  /**
   * 実行中の追加入力。SDK が現在の応答とそのツールの完了後、次のモデル呼び出し前へ渡す。
   * idle ではランを開始しないため、BFF は実行中だけ渡す。拡張の入力ハンドラを await してから
   * 実キューへ積むため、BFF は受付を直列化する。旧 SDK・スタブでは欠けてもよい
   */
  steer?(text: string): Promise<"queued" | "handled">;
  /** SDK が保持する未注入の入力を捨てる。実キューを消す (取消・停止で使う) */
  clearQueue?(): unknown;
  setModel(model: unknown, options?: { persist?: boolean }): Promise<void>;
  /** SDK の SessionManager。compaction の entry を読むためだけに参照する (旧 SDK では undefined) */
  sessionManager?: { getBranch?(): unknown[] };
  /** 手動 compaction。SDK が持たない実装 (スタブ・旧 SDK) では undefined */
  compact?(customInstructions?: string): Promise<unknown>;
  /**
   * 実行中の compaction を中断する。SDK の abort() も内部で呼ぶが、BFF は stop と同じ経路
   * (abort) を通すため単体では使わない。SDK が持たない実装では undefined
   */
  abortCompaction?(): void;
  /** SDK の isCompacting。BFF の保存待ちは含まない (busy 判定は SessionRecord の flag で行う) */
  isCompacting?: boolean;
  /** SDK が非対応値を補正する */
  setThinkingLevel(level: string, options?: { persist?: boolean }): void;
  /** 現在のモデルが選べる thinkingLevel (非推論モデルは ["off"] のみ) */
  getAvailableThinkingLevels(): string[];
  supportsThinking(): boolean;
  /** SDK が持たない実装 (スタブ・旧 SDK) では undefined を返してよい */
  getContextUsage?(): unknown;
  dispose?(): void;
  disposed?: boolean;
}

/** テストや埋め込み側が差し込む pi ランタイムの最小 interface */
export interface PiRuntimeLike {
  createSession(input?: {
    agent?: AgentDef;
    model?: ModelRef;
    thinkingLevel?: ThinkingLevel;
    /** rootCwd 相対の作業ディレクトリ (省略・空文字は root)。BFF が絶対パスへ解決する */
    cwd?: string;
    /** 復元時: アプリのセッション ID */
    sessionId?: string;
    /** 所有権の束縛に使う会話 id。永続化なしでも渡す (SDK の inMemory へ渡す id とは条件が違う) */
    ownerSessionId?: string;
    /** 復元時: JSONL から読んだ entries (header は含めない) */
    entries?: unknown[];
    /** 復元時: 作成時のプロンプトスナップショット */
    promptSnapshot?: PromptSnapshot;
    /** この会話の添付置き場 (root 相対)。参照画像の許可範囲に使う */
    uploadsDirRel?: string;
    /** 共通スキルの許可リスト。undefined = 全可視、`[]` = すべて OFF */
    commonSkillNames?: string[];
    /** 組み込みスキルの許可リスト。undefined = 全部 ON、`[]` = すべて OFF */
    builtinSkillNames?: string[];
    /** false なら解決した全スキルを索引から外す (既定 true) */
    allowNaturalInvocation?: boolean;
    /** ツールの許可リスト。undefined = 全部 ON、`[]` = すべて OFF */
    toolNames?: string[];
    /** 子モード。読み取り専用ツールだけを公開し、常時有効群とスキル発見を落とす (既定 "chat") */
    mode?: "chat" | "investigation";
  }): Promise<{ session: unknown; promptSnapshot?: PromptSnapshot }>;
  /** availableModels との厳密一致。スタブでは未実装でもよい */
  resolveModel?(model: ModelRef): unknown;
}

/** 旧 SDK は sessionManager を持たないため空配列へ落とす (compaction 履歴が無いものとして扱う) */
export function branchEntriesOf(session: PiSessionLike): PiSessionEntryLike[] {
  const entries = session.sessionManager?.getBranch?.();
  return Array.isArray(entries) ? (entries as PiSessionEntryLike[]) : [];
}

export function lastAssistantMessage(session: PiSessionLike): PiSessionLike["messages"][number] | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === "assistant") return session.messages[index];
  }
  return undefined;
}

/** 契約外の usage (部分的な実装・旧 SDK) は数字として扱わず、キーごと落とす。 */
export function parseUsage(raw: unknown): Usage | undefined {
  const parsed = UsageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function contextUsageOf(session: PiSessionLike): ContextUsage | undefined {
  // SDK の getContextUsage() は compaction entry の usage を無条件に読むため、usage を持たない
  // 旧 / 手作り JSONL では例外になる。context は補助情報なので、失敗はキー省略へ縮退させる
  let raw: unknown;
  try {
    raw = session.getContextUsage?.();
  } catch {
    return undefined;
  }
  const parsed = ContextUsageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
