// チャット表示の型。reducer (chatReducer) と純関数 (lib/chatHistory) の双方から使うため独立させる。
import type { CompactionInfo, HistoryContextState, HistoryPage, MessageMetrics, SkillLoad, Usage } from "../types";

export type ToolPhase = "running" | "done" | "failed";

export type ToolCard = {
  id: string;
  name: string;
  args: string;
  phase: ToolPhase;
  output: string;
  /** スキル読み込みのときだけ載る (履歴 / ライブのどちらから来ても同じ DTO) */
  skill?: SkillLoad;
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
