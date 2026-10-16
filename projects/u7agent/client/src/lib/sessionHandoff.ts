/**
 * 会話の引き継ぎ (エージェント / スペースの交代) の純関数。ダイアログの文言と選択の組み立て、実行を
 * 止める理由、引き継ぎ後のチップの導出だけを持つ。
 *
 * チップは会話の状態 (payload の handoff) から導出し、クライアントのメモリには持たない
 * (リロードとスペースの切替をまたいで同じ表示になる)。文面はエージェントの定型プロンプトと同じ形に揃える。
 */
import type { AgentDef, AgentSuggestion, SessionHandoffState, SessionSummary } from "../types";

/** 引き継ぎのチップ。ラベルは固定、送信本文へ足す文も固定 (docs/ui-layout.md) */
export const HANDOFF_CHIP_LABEL = "HANDOFF.mdを参照";
export const HANDOFF_CHIP_PROMPT = "作業フォルダの HANDOFF.md を読んで、この続きをお願いします。";

/**
 * 引き継ぎは成立したが履歴の削除 (片付け) が残ったときの警告。スペースをまたぐ場合は移動先の App が
 * 状態行へ出す (`SpacesApp` が結果を持ち回り、App は入口の解決が終わってから出す)。
 */
export const HANDOFF_CLEANUP_NOTE =
  "引き継ぎは完了しましたが、片付け（履歴の削除）が残っています。会話を開き直すと再試行します。";

/** 移動先へ渡す警告と対象の会話。片付けが残っていない応答では undefined */
export type HandoffNote = { sessionId: string; text: string };

/** 引き継ぎの応答から、移動先へ渡す警告を作る (クライアントのメモリではなくスペースをまたいで渡す) */
export function handoffCleanupNote(
  result: { cleanupPending?: boolean | undefined },
  sessionId: string,
): HandoffNote | undefined {
  return result.cleanupPending ? { sessionId, text: HANDOFF_CLEANUP_NOTE } : undefined;
}

/** ダイアログのエージェント 1 行。`current` は現在のエージェント (カタログから消えていても出す) */
export type HandoffAgentChoice = {
  id: string;
  name: string;
  current: boolean;
};

/**
 * 引き継ぎの実行を止める理由。実行できるなら空文字。
 * busy はサーバーの 409 と同じ条件 (実行中・キュー待ち・圧縮中・設定変更中)、cleanup は確定後の片付け。
 */
export function handoffBlockedReason(item: Pick<SessionSummary, "status" | "queueDepth" | "handoffCleanup">): string {
  if (item.handoffCleanup === true) {
    return "前回の引き継ぎの片付けが残っています。会話を開いてから、もう一度お試しください。";
  }
  // 終端 (completed / stopped / error) は依頼中ではない (サーバーの isBusy と同じ集合)
  const busy = item.status === "running" || item.status === "queued" || item.status === "compacting";
  if (busy || item.queueDepth > 0) {
    return "実行中・キュー待ち・圧縮中は引き継げません。完了を待ってから開き直してください。";
  }
  return "";
}

/** 引き継ぎ先のエージェント一覧。現在のエージェントがカタログから消えていても先頭に残す */
export function handoffAgentChoices(
  agents: AgentDef[],
  currentAgentId: string,
  currentAgentName: string,
): HandoffAgentChoice[] {
  const choices = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    current: agent.id === currentAgentId,
  }));
  if (choices.some((choice) => choice.current)) return choices;
  return [{ id: currentAgentId, name: currentAgentName || "現在のエージェント", current: true }, ...choices];
}

/**
 * 送る `agentId`。現在のエージェントを選んだときは省略する (省略 = 保存済みのスナップショットを維持し、
 * カタログから消えた id でも引き継げる)。
 */
export function handoffAgentId(choice: HandoffAgentChoice): string | undefined {
  return choice.current ? undefined : choice.id;
}

/** メモのトグルを無効にする理由。空なら無効 (メッセージ 0 件では材料が無い) */
export function handoffMemoDisabledReason(messageCount: number): string {
  return messageCount > 0 ? "" : "メモにできる会話がまだありません。";
}

/**
 * 引き継ぎ後に出すチップ。「メモあり」かつ「消費済みでない」ときだけ出す。外す操作は App が持ち、
 * 送信の受理 (consumed) で消える。
 */
export function handoffSuggestion(handoff: SessionHandoffState | undefined): AgentSuggestion | null {
  if (!handoff || !handoff.memo || handoff.consumed) return null;
  return { label: HANDOFF_CHIP_LABEL, prompt: HANDOFF_CHIP_PROMPT };
}

/**
 * 引き継ぎの確認文言。消えるもの (履歴と未送信) と残るもの (作業フォルダのファイルと添付)、
 * 引き継ぎ後に移動先のスペースへ切り替わることを実行前に示す。
 */
export type SessionHandoffDialogText = {
  title: string;
  subject?: { label: string; value: string };
  body: readonly string[];
  agentLabel: string;
  spaceLabel: string;
  memoLabel: string;
  memoDescription: string;
  /** プロジェクト所属だけの注意 (リポジトリ直下にできる。コミット / 除外は利用者判断) */
  memoProjectNote?: string;
  confirmLabel: string;
  note: string;
};

/**
 * 引き継ぎの確認文言。消えるもの (履歴と未送信) と残るもの (作業フォルダのファイルと添付)、
 * 引き継ぎ後に移動先のスペースへ切り替わることを実行前に示す。プロジェクト所属では、メモが
 * リポジトリ直下にできることと、コミット / 除外の判断が利用者にあることをメモの説明へ足す。
 */
export function sessionHandoffDialogText(title: string, projectSession = false): SessionHandoffDialogText {
  return {
    title: "会話を引き継ぐ",
    ...(title ? { subject: { label: "引き継ぐ会話", value: title } } : {}),
    body: [
      "履歴（メッセージと未送信）は破棄されます。元に戻せません。",
      "作業フォルダのファイルと添付は残り、別のスペースを選んだときは移動先へ移ります。",
      "引き継ぎ後は移動先の会話スペースへ切り替わり、引き継ぎ後の会話を開きます。",
    ],
    agentLabel: "引き継ぎ先のエージェント",
    spaceLabel: "移動先の会話スペース",
    memoLabel: "メモを作る",
    memoDescription: "ここまでの要点を作業フォルダの HANDOFF.md に書き出します。すでにあれば先頭に追記します。",
    ...(projectSession ? { memoProjectNote: HANDOFF_PROJECT_MEMO_NOTE } : {}),
    confirmLabel: "引き継ぐ",
    note: "メモを読むかどうかは引き継ぎ後に選べます。",
  };
}

/** メモの説明に足す、プロジェクト所属だけの注意 (リポジトリ直下にできる) */
export const HANDOFF_PROJECT_MEMO_NOTE =
  "プロジェクトではリポジトリ直下にできます。コミットするか除外設定に入れるかはご判断ください。";
