/**
 * ask_user のカード状態と入力の純関数。カードの描画・「回答する」の有効条件・Composer の送信
 * ブロックが同じ判定を共有する (片方だけ変えると「回答済みなのに送信不可」が起きる)。
 */
import type { AskUserAnswer, AskUserQuestion, RunStatus, ToolCall } from "../types";
import type { ToolCard } from "./chatTypes";

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
