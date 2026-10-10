// チャット表示の型。reducer (chatReducer) と純関数 (lib/chatHistory) の双方から使うため独立させる。
import type {
  AskUserAnswer,
  AskUserQuestion,
  CompactionInfo,
  HistoryContextState,
  HistoryPage,
  MessageMetrics,
  RunOutcome,
  SkillLoad,
  Usage,
} from "../types";

export type ToolPhase = "running" | "done" | "failed";

export type ToolCard = {
  id: string;
  name: string;
  args: string;
  phase: ToolPhase;
  output: string;
  /** BFF 計測の実行開始 / 終了 (epoch ms)。両方が揃ったカードだけが実行時間を出せる */
  startedAt?: number;
  endedAt?: number;
  /** スキル読み込みのときだけ載る (履歴 / ライブのどちらから来ても同じ DTO) */
  skill?: SkillLoad;
  /** ask_user の質問。あるカードはツール履歴ではなく専用カードで描画する */
  questions?: AskUserQuestion[];
  /** ask_user の回答。未回答は undefined、停止・中止の結果は空配列 (回答なしで終了) */
  answers?: AskUserAnswer[];
};

export type Bubble = {
  id: number;
  /** 履歴 item の安定 ID (SDK entry id)。ライブ (ストリーミング / ローカルエコー) は持たない */
  entryId?: string;
  /**
   * 履歴 item のコンテキスト状態。summarized = 要約で置き換わった (薄暗く表示)、
   * excluded = retry / overflow の context_edit で context から外れた (要約とは区別して表示)。
   * ライブのバブルは持たない (undefined = 通常表示)。
   */
  context?: HistoryContextState;
  role: "user" | "assistant";
  text: string;
  tools: ToolCard[];
  /** このバブルに出す導出行 (繰り上げ分を含む。カードと重複する分は表示側で落とす) */
  skillLoads: SkillLoad[];
  /**
   * 送信時点で既知だった最新の履歴 item id。run id が分からない旧経路で、run_start の吸収判定を
   * 「これより後に現れた同一文面の entry」に限定するために使う
   */
  since?: string;
  /**
   * この送信を実行する run の id (POST 応答の runId)。ページの user entry と同じ runId のときだけ
   * 対応する履歴 item へ吸収し、別クライアントの同一文面 entry を自分のものと取り違えない
   */
  runId?: string;
  /**
   * run が終わったターンの所要時間と結末。履歴 item (`runDurationMs` / `runOutcome`) と、
   * ライブの `run_end` のどちらから来ても同じ値。ターン終端の行の有無と文言の唯一の根拠
   */
  runDurationMs?: number;
  runOutcome?: RunOutcome;
  /**
   * 202 で受理されたがサーバー再起動で user entry として保存されなかった送信。通常の user バブルと
   * 見分け、再送 / 破棄を出す。pendingEchoIds には残さない (履歴の item へ黙って吸収させない)
   */
  unsent?: boolean;
  /**
   * 202 で受理済みでまだ entry になっていない送信 (キュー待ち / 実行中)。表示は通常の user バブルで、
   * 履歴ページの吸収を待つ。本文の縮退で別の item へ吸収させず、履歴の位置に関わらず末尾へ置く
   */
  accepted?: boolean;
  /**
   * その受理をサーバーが確認済み (payload の queued / running か run_start)。楽観的に受理済みへ
   * 切り替えた再送と区別し、応答が届かない失敗で実行済みの送信を未送信へ戻さないために使う
   */
  confirmed?: boolean;
  /**
   * run が終わって確定したライブバブル (履歴ページがまだ拾っていない分)。resync で捨てずに残し、
   * 履歴ページが届いたら entryId 付きのバブルと置き換える。未確定のストリーミング中だけ false。
   */
  settled?: boolean;
  at?: number;
  usage?: Usage;
  metrics?: MessageMetrics;
};

/** 圧縮イベントの区切り。index は bubbles の何番目の手前に置くか */
export type CompactionMarker = {
  /** compaction entry id (item id) */
  id: string;
  index: number;
  /** この区切りに出す要約。履歴では 1 件、旧 payload では最新区切りの全件 */
  compactions: CompactionInfo[];
};

/** 全履歴ページの取得状態。supported=false は旧サーバー (履歴 API 無し) の表示 */
export type ChatHistoryState = {
  supported: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  loading: boolean;
  /** 現行ブランチ全体の表示メッセージ数 / うち summarized の数 (境界の更新に使う) */
  messageCount: number;
  summarizedMessageCount: number;
  activeContextStartId: string | null;
  /** 最新ページが保持分と繋がらず、欠落区間を取るために使う before カーソル */
  gapCursor: string | null;
  /** 欠落区間の取得後に適用する保留中の最新ページ */
  pendingPage: HistoryPage | null;
};
