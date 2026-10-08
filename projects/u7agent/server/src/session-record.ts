/**
 * セッション 1 件分の状態の形。生成・破棄・競合制御は SessionStore が持ち、
 * projection はこの型を読み取り専用の入力として受け取る。
 */
import type {
  AgentPayloadInfo,
  AskUserAnswer,
  AskUserQuestion,
  CompactionReason,
  EventEntry,
  MessageMetrics,
  ModelRef,
  RunErrorCode,
  RunRetryState,
  RunStatus,
  ThinkingLevel,
  ToolCall,
  ToolTiming,
} from "./schema";
import type { PiSessionLike } from "./pi-runtime";
import type { SessionMeta, SessionFileWriter, PromptSnapshot, UnsentSend } from "./session-store";

export interface RunState {
  id: string;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  /**
   * 最終失敗の分類コード。status === "error" のときだけ立てる (停止と例外が同時でも停止を正とし、
   * 停止直後の再実行カードを出さない)。成功・停止では載せない
   */
  errorCode?: RunErrorCode;
  /** 進行中の自動再試行 (成功・最終失敗・停止で消える)。累計は totalRetryCount に残す */
  retry?: RunRetryState;
  /** ラン中の auto_retry_start 通知の累計 (再試行のスケジュール回数。待機中の中止も含む) */
  totalRetryCount: number;
  /** BFF の stop で abort したか。待機中は aborted の assistant が残らないため、停止判定に使う */
  stopRequested?: boolean;
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

/** キューで待つ送信。run id は受け付けた時点で振り、その run の entry と対応付ける */
export interface QueuedMessage {
  text: string;
  runId: string;
}

/**
 * ask_user の待機 1 件。settle 済みも map に残し (tools と同じ寿命)、同じ toolCallId への
 * 2 回目の回答を「回答済み」= 409 にする。掃除は次の run の startRun が行う。
 */
export interface PendingQuestion {
  questions: AskUserQuestion[];
  resolve: (answers: AskUserAnswer[]) => void;
  reject: (error: Error) => void;
  settled: boolean;
  /** abort listener の解除。settle の直前に呼び、回答済みの等待を後からの abort で消さない */
  detach?: () => void;
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
  queue: QueuedMessage[];
  run: RunState | null;
  tools: Map<string, ToolCall>;
  /**
   * toolCallId -> BFF 計測の実行時間。`tools` は run と同じ寿命 (次の run で作り直す) だが、
   * 履歴の投影は前の run のカードも写すため、セッションの寿命で溜める
   */
  toolTimings: Map<string, ToolTiming>;
  /** ask_user の待機 (toolCallId 引き)。run と同じ寿命で、次の run の開始時に初期化する */
  questions: Map<string, PendingQuestion>;
  /** SDK のメッセージオブジェクト -> BFF 計測の応答時間 (履歴へ写すときに同じ参照で引く) */
  messageMetrics: WeakMap<object, MessageMetrics>;
  /**
   * SDK の user メッセージ -> それを送信した run id。履歴 item の runId に写し、クライアントが
   * 自分の送信エコーを他クライアントの同一文面 entry と取り違えないようにする
   */
  userMessageRuns: WeakMap<object, string>;
  /**
   * 保存済み user entry の id -> run id。実行時の `userMessageRuns` は再起動で消えるため、
   * JSONL へ書いた entry の対応をストア (sends.json) から復元して履歴の runId に使う。
   * 旧保存データには無いので、載らない item は従来どおり本文での縮退になる
   */
  entryRunIds: Map<string, string>;
  /**
   * 202 で受理したがまだ user entry として保存されていない送信 (古い→新しい)。再起動でキューごと
   * 消えても、履歴の同一文面 item へ黙って吸収させず「未送信」として見せるために残す
   */
  unsentSends: UnsentSend[];
  /**
   * 送信対応記録がディスクと食い違っている (受理 / entry の確定で変わったが書けていない)。
   * persist / flush のたびに書込みを再試行し、成功するまで残す
   */
  sendsDirty: boolean;
  /** 直近の送信対応記録の保存失敗。成功で消える (health の dirty にも数える) */
  sendsError?: string;
  /** compaction entry id -> entry に保存されない表示用の値 (compaction_end 受信時に控える) */
  compactionMeta: Map<string, CompactionMeta>;
  /** 設定変更中フラグ。非同期 setModel の間、送信と二重変更を 409 で拒否する */
  changingSettings: boolean;
  /**
   * 手動 compaction の実行中フラグ。SDK の isCompacting と違い、SDK 実行中と保存待ちの
   * 両方で true (排他の正はここで、busy 判定もこの値で行う)
   */
  compacting: boolean;
  /** 手動 compaction の開始時刻 (epoch ms)。payload / SSE の経過時間の起点 */
  compactionStartedAt?: number;
  /** 実行中 compaction の完了 promise。保存・終端配信と排他の解放までを覆う */
  compactionTask?: Promise<unknown>;
  /** 完了を Discord へ送るか。正は meta.notify (live な record はここを更新して永続化する) */
  notify: boolean;
  /** サイドバーに固定するか。meta の欠落は false として復元する */
  pinned: boolean;
}

export interface CreateSessionOptions {
  spaceId?: string;
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
