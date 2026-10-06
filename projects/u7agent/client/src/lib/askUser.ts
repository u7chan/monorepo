/**
 * ask_user のカード状態と入力の純関数。カードの描画・「回答する」の有効条件・Composer の送信
 * ブロックが同じ判定を共有する (片方だけ変えると「回答済みなのに送信不可」が起きる)。
 */
import type { AskUserAnswer, AskUserQuestion, RunStatus, ToolCall } from "../types";

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

/** 質問を 1 つでも未入力のままにできない (「回答しない」は入力済みとして扱う) */
export function askUserDraftsComplete(drafts: readonly AskUserDraft[]): boolean {
  return drafts.every((draft) => draft.skipped || draft.selected.length > 0 || draft.text.trim() !== "");
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
