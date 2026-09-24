/**
 * セッション 1 件分の状態の形。生成・破棄・競合制御は SessionStore が持ち、
 * projection はこの型を読み取り専用の入力として受け取る。
 */
import type {
  AgentPayloadInfo,
  CompactionReason,
  EventEntry,
  MessageMetrics,
  ModelRef,
  RunStatus,
  ThinkingLevel,
  ToolCall,
} from "./schema";
import type { PiSessionLike } from "./pi-runtime";
import type { SessionMeta, SessionFileWriter, PromptSnapshot } from "./session-store";

export interface RunState {
  id: string;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** compaction entry id に紐づく、entry へは保存されない表示用の値 */
export interface CompactionMeta {
  reason?: CompactionReason;
  estimatedTokensAfter?: number;
}

export interface SessionSubscriber {
  send: (entry: EventEntry) => void;
  close?: () => void;
}

export interface SessionRecord {
  id: string;
  session: PiSessionLike;
  agentId: string;
  projectId?: string;
  /** 所属プロジェクトの cwd (root 相対)。projectId は保存せず読み取り時に解決する */
  projectCwd?: string;
  projectName?: string;
  /** セッションの作業ディレクトリ (root 相対)。所属があれば登録ディレクトリ、未所属はスクラッチ
   * (永続化なしの未所属だけ root "")。SDK へも同じ値を cwd として渡す */
  workdir: string;
  /** 会話ストアの絶対パス。空文字は永続化なし */
  storeDir: string;
  /** 作成時のエージェント / スキルプロンプト (定義変更を遡及させない) */
  promptSnapshot: PromptSnapshot;
  /** 会話ストアのメタデータ。永続化なしでも作成時の値を持つ */
  meta: SessionMeta;
  /** このロード世代の識別子。SSE の id は `<generation>:<seq>` */
  generation: string;
  /** JSONL の追記ライター。永続化なしは undefined */
  writer?: SessionFileWriter;
  /** meta / JSONL の書込みを直列化する末尾 (失敗しても reject しない) */
  persistTail: Promise<void>;
  /** 直近の保存失敗 (meta / JSONL 共通)。成功で消える */
  persistError?: string;
  /** 同じエラーを毎回ログに出さないための記録 */
  persistErrorLogged?: string;
  /** 作成時点のスナップショット (定義の編集・削除の影響を受けない) */
  agent: AgentPayloadInfo;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  seq: number;
  events: EventEntry[];
  subscribers: Set<SessionSubscriber>;
  queue: string[];
  run: RunState | null;
  tools: Map<string, ToolCall>;
  /** SDK のメッセージオブジェクト -> BFF 計測の応答時間 (履歴へ写すときに同じ参照で引く) */
  messageMetrics: WeakMap<object, MessageMetrics>;
  /** compaction entry id -> entry に保存されない表示用の値 (compaction_end 受信時に控える) */
  compactionMeta: Map<string, CompactionMeta>;
  /** 設定変更中フラグ。非同期 setModel の間、送信と二重変更を 409 で拒否する */
  changingSettings: boolean;
  /** 完了を Discord へ送るか。正は meta.notify (live な record はここを更新して永続化する) */
  notify: boolean;
}

export interface CreateSessionOptions {
  agentId?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  projectId?: string;
  /** 新規チャットで選んだ通知トグル (未指定は false) */
  notify?: boolean;
}

/** 一覧用の軽量な記述子。SDK セッションを開かずに meta から作る */
export interface SessionDescriptor {
  meta: SessionMeta;
}

export interface UpdateSessionSettingsInput {
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

export interface PostMessageResultInternal {
  queued: boolean;
  queueDepth: number;
  runId?: string;
}
