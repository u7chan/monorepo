/**
 * ask_user のカード状態と入力の純関数。カードの描画・「回答する」の有効条件・Composer の送信
 * ブロックが同じ判定を共有する (片方だけ変えると「回答済みなのに送信不可」が起きる)。
 */
import type { AskUserAnswer, AskUserQuestion, RunStatus, ToolCall } from "../types";
import type { ToolCard } from "./chatTypes";
import type { ConfirmRequest } from "./confirmDialog";

/** サーバーの同名定数は types.ts の再配布に載らないため、クライアント側に置く */
export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * SSE の status はリプレイされないため復帰の文言はクライアントが持ち、サーバーの run-events.ts と
 * 同じ文字列を二重に定義する (types.ts は型だけを再配布する契約)。
 */
export const ASK_USER_WAITING_TEXT = "回答を待っています…";

/** 質問ごとの入力。`skipped` は「回答しない」で、選択 / 自由記入とは排他 */
export type AskUserDraft = {
  selected: string[];
  text: string;
  skipped: boolean;
};

/** 質問を持ち、回答がまだ届かず、ツールも終わっていない = 回答待ち */
export function isPendingAskUser(call: ToolCall): boolean {
  return Boolean(call.questions?.length) && call.answers === undefined && !call.done;
}

/**
 * カード側 (ToolCard) の同じ判定。履歴ページのマージは runTools を持たないため、
 * 回答待ちのバブルをページ先頭へ繰り上げない判定にこれを使う。
 */
export function isPendingAskUserCard(card: ToolCard): boolean {
  return Boolean(card.questions?.length) && card.answers === undefined && card.phase === "running";
}

/**
 * 回答待ちの質問数 (カード数ではなく質問単位)。run が実行中のときだけ数える:
 * 終了後に残ったカードは回答できないため、送信をブロックし続けない。
 */
export function pendingAskUserQuestionCount(runTools: Record<string, ToolCall>, runStatus: RunStatus): number {
  if (runStatus !== "running") return 0;
  let count = 0;
  for (const call of Object.values(runTools)) {
    if (isPendingAskUser(call)) count += call.questions?.length ?? 0;
  }
  return count;
}

export function emptyAskUserDrafts(questions: readonly AskUserQuestion[]): AskUserDraft[] {
  return questions.map(() => ({ selected: [], text: "", skipped: false }));
}

/** 質問 1 つ分の入力 (questions の外を参照しないための安全な取り出し) */
export function askUserDraftAt(drafts: readonly AskUserDraft[], index: number): AskUserDraft {
  return drafts[index] ?? { selected: [], text: "", skipped: false };
}

/** 質問 1 つ分が回答済みか (「回答しない」は回答済みとして扱う) */
export function askUserDraftResolved(draft: AskUserDraft): boolean {
  return draft.skipped || draft.selected.length > 0 || draft.text.trim() !== "";
}

/** 質問 1 つ分の選択数。自由記入も 1 件として数える (カードの「N 件選択」) */
export function askUserDraftSelectedCount(draft: AskUserDraft): number {
  if (draft.skipped) return 0;
  return draft.selected.length + (draft.text.trim() !== "" ? 1 : 0);
}

/** 質問を 1 つでも未入力のままにできない (「回答しない」は入力済みとして扱う) */
export function askUserDraftsComplete(drafts: readonly AskUserDraft[]): boolean {
  return drafts.every(askUserDraftResolved);
}

/** 未回答の質問数。閉じる操作の補足と確認が「回答なし」で送る件数として使う */
export function askUserUnresolvedCount(drafts: readonly AskUserDraft[]): number {
  return drafts.filter((draft) => !askUserDraftResolved(draft)).length;
}

/**
 * `from` の次 (末尾まで見て無ければ先頭) で最初の未回答の質問。1 枚ずつ出すカードが
 * 「送る前に未回答の質問へ戻す」ために使う (見つからなければ undefined)。
 */
export function nextUnresolvedAskUserIndex(drafts: readonly AskUserDraft[], from: number): number | undefined {
  for (let step = 1; step <= drafts.length; step += 1) {
    const index = (from + step) % drafts.length;
    if (!askUserDraftResolved(askUserDraftAt(drafts, index))) return index;
  }
  return undefined;
}

/** 閉じる操作の補足。未回答がある間だけ、閉じたときに残りが「回答なし」になることを示す */
export function askUserCloseNotice(unresolved: number): string | undefined {
  return unresolved > 0 ? `閉じると、未回答の質問 ${unresolved} 件は「回答なし」で送信されます。` : undefined;
}

/**
 * 未回答を残したまま閉じるときの確認。未回答が無いときは確認しない (送るのは回答済みの内容だけで、
 * 押し間違えで失うものが無い)。
 */
export function askUserCloseConfirmRequest(unresolved: number): ConfirmRequest | undefined {
  const notice = askUserCloseNotice(unresolved);
  if (notice === undefined) return undefined;
  return {
    kind: "confirm",
    title: "質問を閉じる",
    body: [`回答済みの内容はそのまま送信します。${notice}`],
    confirmLabel: "回答なしで送る",
  };
}

/** 閉じる確認の前後で見る、確定時点のカードの状態 */
export type AskUserCloseState = {
  cardId: string;
  /** カードがまだ回答待ちのフォームで、閉じる操作を受け付けるか (unmount / settle で false) */
  closable: boolean;
};

/** `✕` でカードを閉じるときの依存。確認と送信の実体は呼び出し側 (カード) が持つ */
export type AskUserCloseDeps = {
  /** 確認を開始したカードの toolCallId */
  cardId: string;
  drafts: readonly AskUserDraft[];
  /** 確定時点のカード。確認中に失効すると `closable` が false になる */
  state: () => AskUserCloseState;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  send: (answers: AskUserAnswer[]) => Promise<void>;
};

/**
 * `✕` でカードを閉じる。未回答が残るときだけ確認を挟み、確定時にカードが失効していたら送らない。
 * 確認を開いている間に会話が切り替わると、送信は確定時の会話へ古い `cardId` で飛ぶ (toolCallId の
 * 会話をまたいだ一意性は契約に無い) ため、送る直前にカードの生存を確かめる。
 */
export async function closeAskUserCard(deps: AskUserCloseDeps): Promise<void> {
  const request = askUserCloseConfirmRequest(askUserUnresolvedCount(deps.drafts));
  if (request !== undefined && !(await deps.confirm(request))) return;
  const current = deps.state();
  if (!current.closable || current.cardId !== deps.cardId) return;
  await deps.send(askUserAnswersClosing(deps.drafts));
}

/**
 * カードを閉じたときの回答。回答済みはそのまま、未回答は「回答しない」にして送る
 * (入力を捨てない。閉じる操作で走っている質問を残さない)。
 */
export function askUserAnswersClosing(drafts: readonly AskUserDraft[]): AskUserAnswer[] {
  const closed = drafts.map((draft) =>
    askUserDraftResolved(draft) ? draft : { selected: [], text: "", skipped: true },
  );
  return askUserAnswersFromDrafts(closed);
}

/** 記録に出す 1 行。選択と自由記入を並べ、回答なしは undefined (表示側で「回答なし」を出す) */
export function askUserAnswerText(answer: AskUserAnswer | undefined): string | undefined {
  if (answer === undefined || answer.skipped === true) return undefined;
  const parts = [...(answer.selected ?? []), ...(answer.text ? [answer.text] : [])];
  return parts.length > 0 ? parts.join("、") : undefined;
}

/**
 * 送信された回答に中身が 1 つも無い (全問「回答しない」/ 中止の空回答 / 回答が未着)。行ごとの
 * 表示 (askUserAnswerText) と同じ規則で見る: `answers` の有無で見ると全問「回答しない」が素通りする。
 */
export function askUserAnsweredNothing(answers: readonly AskUserAnswer[] | undefined): boolean {
  return (answers ?? []).every((answer) => askUserAnswerText(answer) === undefined);
}

/** 送信する回答。index は質問の並びで振る (サーバーは index の集合が全質問と一致することを要求する) */
export function askUserAnswersFromDrafts(drafts: readonly AskUserDraft[]): AskUserAnswer[] {
  return drafts.map((draft, index) => {
    if (draft.skipped) return { index, skipped: true };
    const text = draft.text.trim();
    return {
      index,
      ...(draft.selected.length > 0 ? { selected: [...draft.selected] } : {}),
      ...(text !== "" ? { text } : {}),
    };
  });
}

/** 選択肢のトグル。multiSelect が false のときは 1 つだけ残す */
export function toggleAskUserOption(draft: AskUserDraft, label: string, multiSelect: boolean): AskUserDraft {
  const selected = multiSelect
    ? draft.selected.includes(label)
      ? draft.selected.filter((value) => value !== label)
      : [...draft.selected, label]
    : draft.selected.includes(label)
      ? []
      : [label];
  return { ...draft, selected, skipped: false };
}
