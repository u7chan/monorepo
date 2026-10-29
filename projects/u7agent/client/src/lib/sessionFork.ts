/**
 * 会話の分岐の純関数。行メニューの無効理由、ダイアログの文言、要求の組み立て、分岐元 / 分岐先の
 * リンク、遅れて届いた応答で選択を巻き戻さない判定だけを持つ。
 *
 * 分岐は元の会話を残したまま、その末尾までの履歴を持つ別の会話を作る。作業フォルダと添付は共有し、
 * 未送信・通知・ピンは引き継がない (契約は docs/run-lifecycle.md)。
 */
import type { AgentDef, SessionSummary } from "../types";
import type { HandoffAgentChoice } from "./sessionHandoff";
import { handoffAgentChoices, handoffAgentId, handoffBlockedReason } from "./sessionHandoff";

/** 分岐を実行できない理由。実行できるなら空文字 (サーバーの 409 と同じ busy / 片付けの条件) */
export function forkBlockedReason(item: Pick<SessionSummary, "status" | "queueDepth" | "handoffCleanup">): string {
  return handoffBlockedReason(item);
}

/** 分岐先のエージェント一覧。現在のエージェントがカタログから消えていても先頭に残す */
export function forkAgentChoices(
  agents: AgentDef[],
  currentAgentId: string,
  currentAgentName: string,
): HandoffAgentChoice[] {
  return handoffAgentChoices(agents, currentAgentId, currentAgentName);
}

/**
 * 送る `agentId`。現在のエージェントを選んだときは省略する (省略 = 親のスナップショットを維持し、
 * カタログから消えた id でも分岐できる)。
 */
export function forkAgentId(choice: HandoffAgentChoice): string | undefined {
  return handoffAgentId(choice);
}

/** 分岐の要求。子のスペースと作業フォルダは親から決まるため、本文はエージェントだけ */
export type SessionForkRequest = { agentId?: string };

export function forkRequest(choice: HandoffAgentChoice): SessionForkRequest {
  const agentId = forkAgentId(choice);
  return agentId === undefined ? {} : { agentId };
}

/** 分岐の確認文言。残るもの (元の会話と履歴) と共有するもの (作業フォルダ / 添付)、引き継がないもの */
export type SessionForkDialogText = {
  title: string;
  subject?: { label: string; value: string };
  body: readonly string[];
  agentLabel: string;
  /** 別のエージェントを選んだときに出す注意。現在のままなら空 */
  agentNote: string;
  confirmLabel: string;
  note: string;
};

export function sessionForkDialogText(title: string): SessionForkDialogText {
  return {
    title: "会話を分岐",
    ...(title ? { subject: { label: "分岐する会話", value: title } } : {}),
    body: [
      "ここまでの履歴を持つ新しい会話を作ります。元の会話はそのまま残ります。",
      "作業フォルダと添付は元の会話と共有します。片方の変更はもう片方にも見えます。",
      "未送信のメッセージ・通知・ピンは引き継ぎません。",
    ],
    agentLabel: "分岐先のエージェント",
    agentNote: "エージェントを変えると、役割・指示・ツールの許可が変わります。",
    confirmLabel: "分岐する",
    note: "分岐した会話には分岐元のリンクが出ます。",
  };
}

/** 分岐元 / 分岐先のリンク 1 件 */
export type ForkLinkItem = { sessionId: string; title: string };

export type ForkRelations = {
  /** 分岐元。自分が分岐していなければ undefined、親が一覧に無ければ "deleted" */
  origin?: ForkLinkItem | "deleted";
  /** この会話から分岐した会話 (同じスペースの一覧から引く) */
  children: ForkLinkItem[];
};

/**
 * 分岐元 / 分岐先のリンク。子一覧のサーバー API は足さず、同じスペースの一覧から
 * `parentSessionId` で引く (親を消しても子は開け、分岐元は削除済みとして示す)。
 */
export function forkRelations(
  sessions: readonly SessionSummary[],
  current: { sessionId: string; parentSessionId?: string },
): ForkRelations {
  const children = sessions
    .filter((item) => item.parentSessionId === current.sessionId)
    .map((item) => ({ sessionId: item.sessionId, title: item.title }));
  if (!current.parentSessionId) return { children };
  const parent = sessions.find((item) => item.sessionId === current.parentSessionId);
  return {
    origin: parent ? { sessionId: parent.sessionId, title: parent.title } : "deleted",
    children,
  };
}

/** 分岐元が削除されているときの表示 (子はそのまま使えることを伝える) */
export const FORK_ORIGIN_DELETED_NOTE = "分岐元の会話は削除されています";

/**
 * 分岐の応答を受け取った後に子を開くか。要求を出した後に利用者が別の会話を選んでいたら
 * (選択の世代が進んでいたら)、遅れて届いた応答でその選択を巻き戻さない。
 */
export function forkOpenDecision(requested: number, current: number): "open" | "keep" {
  return requested === current ? "open" : "keep";
}
