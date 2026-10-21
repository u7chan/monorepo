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
  RunOutcome,
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
  /** この実行を開始した送信のID。所要時間・結末はこの送信にだけ写す */
  initialSendId: string;
  /** 開始送信の user 注入を観測したか。観測するまで steering は SDK へ渡さない */
  initialInjected?: boolean;
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
  /** BFF 計測の圧縮時間。失敗・中止では記録しない (区切りごと出さない) */
  durationMs?: number;
}

export interface SessionSubscriber {
  send: (entry: EventEntry) => void;
  close?: () => void;
}

/**
 * BFF が配送を持つ追加入力。SDK へは先頭 1 件だけを steering として渡し、注入を観測したら次を渡す。
 * run id は注入時に確定する (未注入のまま終端したら外し、次の実行へ割り当て直す)。
 */
export interface QueuedSend {
  /** 受付ごとに振る送信ID。同じ本文でも別IDとし、再送では変えない */
  sendId: string;
  text: string;
  at: number;
  /** 実行へ割り当て済みなら実行ID (未注入・手動圧縮待ちは undefined) */
  runId?: string;
  /**
   * SDK へ steering として渡した 1 件。実キューから取り出されたかは SDK の公開 API で判定する
   * (この印だけで取消の成否を決めない)
   */
  handedOff?: boolean;
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
  /** セッションの作業ディレクトリ (root 相対)。所属があれば登録ディレクトリ、未所属は所属スペースのスクラッチ
   * (root "" は永続化なしの既定スペースだけ)。SDK へも同じ値を cwd として渡す */
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
  queue: QueuedSend[];
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
   * SDK の user メッセージ -> それを送信した送信IDと実行ID。履歴 item に写し、クライアントが
   * 自分の送信エコーを他クライアントの同一文面 entry と取り違えないようにする
   */
  userMessageSends: WeakMap<object, { sendId: string; runId?: string }>;
  /**
   * SDK の assistant メッセージ -> 実行内で一意な応答ID。live の delta / ツールと、保存する
   * JSONL entry / 履歴 item を同じ ID で対応付ける
   */
  assistantMessageIds: WeakMap<object, string>;
  /**
   * 保存済み user entry の id -> 送信IDと実行ID。実行時の `userMessageSends` は再起動で消えるため、
   * JSONL へ書いた entry の対応を復元して履歴に使う。旧保存データは 1送信=1実行として補完する
   */
  entrySends: Map<string, { sendId: string; runId?: string }>;
  /**
   * 実行を開始した送信のID (run id -> sendId)。所要時間・結末を開始送信だけに写すために使う。
   * `runOutcomes` と同じくメモリのみ・セッションの寿命
   */
  runInitialSends: Map<string, string>;
  /**
   * 現在の実行で user への注入を観測したがまだ JSONL へ保存されていない送信ID。待機一覧では
   * `running` として扱い、保存が確定したら消す
   */
  injectedSends: Set<string>;
  /** stop の処理中。新規送信を 409 にし、回収後の自動配送を止める */
  stopping: boolean;
  /** 進行中の SDK steering 受付 (取消・停止と直列化する) */
  steerTask?: Promise<void>;
  /**
   * 202 で受理したがまだ user entry として保存されていない送信 (古い→新しい)。再起動でキューごと
   * 消えても、履歴の同一文面 item へ黙って吸収させず「未送信」として見せるために残す。
   * 待機・配送・保存済みの判定はすべて `sendId` をキーにする
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
  /**
   * run id -> ラン全体の所要時間と終端の結末 (finish() で控える)。履歴の user item とライブのパブルへ
   * 写す値の正で、`toolTimings` と同じくメモリのみ・セッションの寿命
   */
  runOutcomes: Map<string, { durationMs: number; outcome: RunOutcome }>;
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
  /** 受付ごとの送信ID。再送では同じ値を返す */
  sendId: string;
  /** 実行へ割り当て済みなら実行ID (待機しただけの送信では省略する) */
  runId?: string;
  /**
   * 引き継ぎの「消費済み」印の保存。この送信が印を立てたか、同じ印の保存が進行中のときに入り、
   * ルートは 202 を返す前に待つ (未保存のまま受理を返すと、再起動でチップが戻る)。
   */
  handoffSaving?: Promise<string | undefined>;
}
