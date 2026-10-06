import { useState } from "react";
import type { ToolCard } from "../../hooks/chatReducer";
import {
  askUserAnswersFromDrafts,
  askUserDraftsComplete,
  emptyAskUserDrafts,
  isPendingAskUserCard,
  toggleAskUserOption,
  type AskUserDraft,
} from "../../lib/askUser";
import { cn } from "../../lib/cn";
import type { AskUserAnswer, AskUserQuestion } from "../../types";

type AnswerResult = { ok: true } | { ok: false; error: string };

/** 記録表示に使う回答。送信直後は手元の入力から組み、届いた answers があればそれを正とする */
function recordAnswers(card: ToolCard, drafts: readonly AskUserDraft[], sent: boolean): AskUserAnswer[] | undefined {
  if (card.answers !== undefined) return card.answers;
  return sent ? askUserAnswersFromDrafts(drafts) : undefined;
}

function QuestionHeading({ question, answered }: { question: AskUserQuestion; answered: boolean }) {
  return (
    <legend className="grid min-w-0 gap-0.5">
      {question.header ? (
        <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">{question.header}</span>
      ) : null}
      <span className={cn("text-1sm font-medium break-words", answered ? "text-ink-soft" : "text-ink")}>
        {question.question}
      </span>
    </legend>
  );
}

/** 選択肢と自由記入の入力。全質問が埋まるまで送信できない */
function AskUserForm({
  questions,
  drafts,
  sending,
  error,
  compact,
  onChange,
  onSubmit,
}: {
  questions: AskUserQuestion[];
  drafts: AskUserDraft[];
  sending: boolean;
  error?: string | undefined;
  compact: boolean;
  onChange: (index: number, next: AskUserDraft) => void;
  onSubmit: () => void;
}) {
  const complete = askUserDraftsComplete(drafts);
  return (
    <form
      className={cn("grid", compact ? "gap-3" : "gap-3.5")}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {questions.map((question, index) => {
        const draft = drafts[index] ?? { selected: [], text: "", skipped: false };
        return (
          <fieldset key={index} disabled={sending} className="grid min-w-0 gap-1.5 border-0 p-0">
            <QuestionHeading question={question} answered={false} />
            {question.options && question.options.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const pressed = draft.selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={pressed}
                      onClick={() =>
                        onChange(index, toggleAskUserOption(draft, option.label, question.multiSelect === true))
                      }
                      className={cn(
                        "grid min-h-8 max-w-60 cursor-pointer gap-0.5 rounded-lg border px-2.5 py-1.5 text-left text-2xs transition-colors",
                        pressed
                          ? "border-accent bg-accent-wash text-accent-text"
                          : "border-line text-ink-soft hover:border-accent/50 hover:text-accent-text",
                      )}
                    >
                      <span className="break-words">{option.label}</span>
                      {option.description ? (
                        <span className="text-3xs break-words text-ink-faint">{option.description}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <textarea
              rows={1}
              value={draft.text}
              disabled={sending}
              placeholder={question.placeholder ?? "自由記入"}
              onChange={(event) => onChange(index, { ...draft, text: event.target.value, skipped: false })}
              onKeyDown={(event) => {
                // Enter は送信、Shift+Enter は改行。未回答が残っている間は送信しない (入力を消さない)
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                if (complete) onSubmit();
              }}
              className={cn(
                "min-h-8 w-full resize-y rounded-lg border border-line bg-base px-2.5 py-1.5 text-1sm text-ink",
                "placeholder:text-ink-ghost focus-visible:border-accent focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-45",
              )}
            />
            <label className="flex w-fit cursor-pointer items-center gap-1.5 text-2xs text-ink-muted">
              <input
                type="checkbox"
                checked={draft.skipped}
                disabled={sending}
                onChange={(event) =>
                  onChange(index, {
                    selected: event.target.checked ? [] : draft.selected,
                    text: event.target.checked ? "" : draft.text,
                    skipped: event.target.checked,
                  })
                }
                className="size-4 shrink-0 accent-focus"
              />
              回答しない
            </label>
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-2xs text-ink-faint">
          {error ? (
            <span role="alert" className="text-danger-text">
              {error}
            </span>
          ) : complete ? (
            "選択肢は入力補助です。自由記入でも送信できます"
          ) : (
            "すべての質問に回答すると送信できます"
          )}
        </span>
        <button type="submit" className="btn-primary" disabled={!complete || sending}>
          {sending ? "送信中…" : "回答する"}
        </button>
      </div>
    </form>
  );
}

/** 回答済み / 回答なしで終了の記録。選択と自由記入を質問ごとに並べる */
function AskUserRecord({
  questions,
  answers,
  compact,
  note,
}: {
  questions: AskUserQuestion[];
  answers: AskUserAnswer[] | undefined;
  compact: boolean;
  note?: string;
}) {
  const answered = answers !== undefined && answers.length > 0;
  return (
    <div className={cn("grid", compact ? "gap-2.5" : "gap-3")}>
      {questions.map((question, index) => {
        const answer = answers?.find((item) => item.index === index);
        const skipped = !answer || answer.skipped === true;
        return (
          <div key={index} className="grid min-w-0 gap-1">
            <QuestionHeading question={question} answered />
            {skipped ? (
              <span className="text-2xs text-ink-faint">回答なし</span>
            ) : (
              <div className="grid min-w-0 gap-1">
                {answer.selected && answer.selected.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {answer.selected.map((label) => (
                      <span
                        key={label}
                        className="rounded-md border border-line bg-soft/40 px-1.5 py-0.5 text-2xs break-words"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {answer.text ? (
                  <p className="m-0 rounded-lg border border-line/70 bg-soft/30 px-2.5 py-1.5 text-2xs break-words whitespace-pre-wrap">
                    {answer.text}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      {note || !answered ? <span className="text-2xs text-ink-faint">{note ?? "回答なしで終了"}</span> : null}
    </div>
  );
}

/**
 * ask_user の質問カード。回答待ちは入力フォーム、回答後は Q&A の記録として出す。
 * 回答の所有は run 側 (runTools) にあり、このカードは `answers` が届くまで待つ。
 */
export function AskUserCard({
  card,
  answerable,
  onAnswer,
  compact,
}: {
  card: ToolCard;
  /** 実行中の run に属するカードだけ回答できる (履歴の復元は記録表示のみ) */
  answerable: boolean;
  onAnswer: (toolCallId: string, answers: AskUserAnswer[]) => Promise<AnswerResult>;
  compact: boolean;
}) {
  const questions = card.questions ?? [];
  const [drafts, setDrafts] = useState<AskUserDraft[]>(() => emptyAskUserDrafts(questions));
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  const waiting = answerable && isPendingAskUserCard(card);
  const answers = recordAnswers(card, drafts, sent);
  const showForm = waiting && answers === undefined;

  const submit = async (): Promise<void> => {
    if (sending || !askUserDraftsComplete(drafts)) return;
    setSending(true);
    setError(undefined);
    const result = await onAnswer(card.id, askUserAnswersFromDrafts(drafts));
    setSending(false);
    if (result.ok) {
      // answers が届くまでは手元の入力を記録として見せる (tool_end は同じバッチの完了を待つことがある)
      setSent(true);
      return;
    }
    setError(result.error);
  };

  return (
    <section
      aria-label={showForm ? "エージェントからの質問" : "エージェントからの質問と回答"}
      className={cn(
        "grid min-w-0",
        showForm
          ? "gap-3 rounded-xl border border-line bg-panel px-3 py-2.5"
          : "rounded-xl border border-line/70 bg-soft/20 px-3 py-2.5",
      )}
    >
      {!showForm ? (
        <span className="mb-1.5 font-sans text-3xs tracking-wide text-ink-faint uppercase">
          {answers !== undefined && answers.length > 0 ? "質問と回答" : waiting ? "回答を送信しました" : "質問"}
        </span>
      ) : null}
      {showForm ? (
        <AskUserForm
          questions={questions}
          drafts={drafts}
          sending={sending}
          error={error}
          compact={compact}
          onChange={(index, next) => setDrafts((current) => current.map((draft, i) => (i === index ? next : draft)))}
          onSubmit={() => void submit()}
        />
      ) : (
        <AskUserRecord
          questions={questions}
          answers={answers}
          compact={compact}
          note={waiting ? "回答を送信しました。反映を待っています…" : undefined}
        />
      )}
    </section>
  );
}
