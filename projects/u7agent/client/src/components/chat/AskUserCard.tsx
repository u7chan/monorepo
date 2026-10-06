import { useState } from "react";
import type { ToolCard } from "../../hooks/chatReducer";
import {
  askUserAnswerText,
  askUserAnswersClosing,
  askUserAnswersFromDrafts,
  askUserDraftAt,
  askUserDraftResolved,
  askUserDraftSelectedCount,
  askUserDraftsComplete,
  emptyAskUserDrafts,
  isPendingAskUserCard,
  nextUnresolvedAskUserIndex,
  toggleAskUserOption,
  type AskUserDraft,
} from "../../lib/askUser";
import { cn } from "../../lib/cn";
import { isImeComposingEnter } from "../../lib/composerKeys";
import type { AskUserAnswer, AskUserQuestion } from "../../types";
import { ArrowRightIcon, CheckIcon, ChevronIcon, ChevronLeftIcon, CloseIcon, PencilIcon } from "../icons";

type AnswerResult = { ok: true } | { ok: false; error: string };

/** 記録表示に使う回答。送信直後は手元の入力から組み、届いた answers があればそれを正とする */
function recordAnswers(card: ToolCard, drafts: readonly AskUserDraft[], sent: boolean): AskUserAnswer[] | undefined {
  if (card.answers !== undefined) return card.answers;
  return sent ? askUserAnswersFromDrafts(drafts) : undefined;
}

/** multiSelect の印。選択の状態は行の button が持つため、印そのものは読み上げの対象にしない */
function ChoiceMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm border text-on-accent",
        checked ? "border-accent bg-accent" : "border-line-strong",
      )}
    >
      {checked ? <CheckIcon /> : null}
    </span>
  );
}

/**
 * 選択肢 1 行。単一選択は行そのものが選択の印になり、番号や枠は出さない (選択中は面と文字色で示す)。
 * multiSelect のときだけチェックを出す。
 */
function OptionRow({
  option,
  pressed,
  multiSelect,
  disabled,
  onToggle,
}: {
  option: { label: string; description?: string | undefined };
  pressed: boolean;
  multiSelect: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
        pressed ? "bg-accent-wash text-accent-text" : "text-ink hover:bg-soft/40",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      {multiSelect ? <ChoiceMark checked={pressed} /> : null}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-1sm break-words">{option.label}</span>
        {option.description ? <span className="text-2xs break-words text-ink-faint">{option.description}</span> : null}
      </span>
    </button>
  );
}

/**
 * 自由記入の行。行のまま入力でき、入力があれば他の選択肢と同じく 1 件として数える。
 * ラベルで包むので、行のどこを押しても入力に入る。
 */
function TextRow({
  question,
  draft,
  multiSelect,
  compact,
  disabled,
  onChange,
  onAdvance,
}: {
  question: AskUserQuestion;
  draft: AskUserDraft;
  multiSelect: boolean;
  compact: boolean;
  disabled: boolean;
  onChange: (text: string) => void;
  onAdvance: () => void;
}) {
  return (
    <label className={cn("flex min-h-10 items-center gap-2.5 px-3 py-1.5", disabled && "cursor-not-allowed")}>
      {multiSelect ? (
        <ChoiceMark checked={draft.text.trim() !== ""} />
      ) : (
        <span className="text-ink-faint">
          <PencilIcon />
        </span>
      )}
      <input
        type="text"
        value={draft.text}
        disabled={disabled}
        aria-label={`${question.question} に自由記入する`}
        placeholder={question.placeholder ?? "その他の回答（自由記入）"}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter は「次へ」と同じ。compact は送信ボタンに任せ (Composer と同じ契約)、
          // IME の変換確定 Enter では進めない (変換しただけで質問が変わらないようにする)
          if (compact || event.key !== "Enter" || event.shiftKey) return;
          const { isComposing, keyCode } = event.nativeEvent;
          if (isImeComposingEnter({ isComposing, keyCode })) return;
          event.preventDefault();
          onAdvance();
        }}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-1sm text-ink outline-none placeholder:text-ink-ghost disabled:cursor-not-allowed disabled:opacity-45"
      />
    </label>
  );
}

/** 質問を 1 枚ずつ出す送り。回答の有無では止めない (未回答のまま見比べられる) */
function QuestionPager({
  index,
  count,
  disabled,
  onMove,
}: {
  index: number;
  count: number;
  disabled: boolean;
  onMove: (delta: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-ink-faint">
      <button
        type="button"
        aria-label="前の質問"
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
        className="composer-status-icon size-6"
      >
        <ChevronLeftIcon />
      </button>
      <span aria-live="polite" className="px-0.5 text-2xs tabular-nums">
        {index + 1} / {count}
      </span>
      <button
        type="button"
        aria-label="次の質問"
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
        className="composer-status-icon size-6"
      >
        <ChevronIcon />
      </button>
    </div>
  );
}

/** 1 問分の入力。選択肢と自由記入の行を罫線で並べ、フッターに選択数と送りを出す */
function AskUserForm({
  questions,
  drafts,
  index,
  sending,
  error,
  compact,
  onChange,
  onMove,
  onSkip,
  onAdvance,
  onClose,
}: {
  questions: AskUserQuestion[];
  drafts: AskUserDraft[];
  index: number;
  sending: boolean;
  error?: string | undefined;
  compact: boolean;
  onChange: (next: AskUserDraft) => void;
  onMove: (delta: number) => void;
  onSkip: () => void;
  onAdvance: () => void;
  onClose: () => void;
}) {
  const question = questions[index];
  if (question === undefined) return null;
  const draft = askUserDraftAt(drafts, index);
  const resolved = askUserDraftResolved(draft);
  const selected = askUserDraftSelectedCount(draft);
  const unresolved = drafts.filter((item) => !askUserDraftResolved(item)).length;
  const last = index === questions.length - 1;
  // 1 問だけのカードは「他に未回答がある」ことが無いので、いまの質問の選択数を出す
  const multi = questions.length > 1;
  // いまの質問以外の未回答。「→」が送信ではなくその質問へ戻す動きになる判定 (advance と同じ)
  const pendingOthers = drafts.filter((item, i) => i !== index && !askUserDraftResolved(item)).length;
  const options = question.options ?? [];
  return (
    <div className="grid">
      <div
        className={cn(
          "flex items-start justify-between gap-2 border-b border-line/60",
          compact ? "px-2.5 py-1.5" : "px-3 py-2",
        )}
      >
        <div className="grid min-w-0 gap-0.5">
          {question.header ? (
            <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">{question.header}</span>
          ) : null}
          <p className="m-0 text-1sm font-medium break-words text-ink">{question.question}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <QuestionPager index={index} count={questions.length} disabled={sending} onMove={onMove} />
          <button
            type="button"
            aria-label="質問を閉じる（未回答は回答なしで送る）"
            disabled={sending}
            onClick={onClose}
            className="composer-status-icon size-6"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div role="group" aria-label={question.question} className="grid divide-y divide-line/60">
        {options.map((option) => (
          <OptionRow
            key={option.label}
            option={option}
            pressed={draft.selected.includes(option.label)}
            multiSelect={question.multiSelect === true}
            disabled={sending}
            onToggle={() => onChange(toggleAskUserOption(draft, option.label, question.multiSelect === true))}
          />
        ))}
        <TextRow
          question={question}
          draft={draft}
          multiSelect={question.multiSelect === true}
          compact={compact}
          disabled={sending}
          onChange={(text) => onChange({ ...draft, text, skipped: false })}
          onAdvance={onAdvance}
        />
      </div>
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-t border-line/60",
          compact ? "px-2.5 py-1.5" : "px-3 py-2",
        )}
      >
        <span aria-live="polite" className="text-2xs text-ink-faint">
          {error !== undefined ? (
            <span role="alert" className="text-danger-text">
              {error}
            </span>
          ) : sending ? (
            "送信中…"
          ) : multi && last && unresolved > 0 ? (
            <span className="text-warn">未回答の質問が {unresolved} 件あります</span>
          ) : draft.skipped ? (
            "回答しない"
          ) : selected > 0 ? (
            `${selected} 件選択`
          ) : (
            "未選択"
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={sending}
            onClick={onSkip}
            className={cn("btn-quiet min-h-8 px-2.5 text-2xs", draft.skipped && "border-accent text-accent-text")}
          >
            回答しない
          </button>
          <button
            type="button"
            aria-label={!last ? "次の質問へ" : pendingOthers > 0 ? "未回答の質問へ戻る" : "回答を送る"}
            disabled={sending || !resolved}
            onClick={onAdvance}
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-on-accent transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ArrowRightIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 回答済み / 回答なしで終了の記録。質問 (淡) と回答 (濃) の組を並べる */
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
  return (
    <div className={cn("grid", compact ? "gap-2.5" : "gap-3")}>
      {questions.map((question, index) => {
        const text = askUserAnswerText(answers?.find((item) => item.index === index));
        return (
          <div key={index} className="grid min-w-0 gap-0.5">
            <span className="text-2xs break-words text-ink-faint">{question.question}</span>
            <span className={cn("text-1sm break-words whitespace-pre-wrap", text === undefined && "text-ink-faint")}>
              {text ?? "回答なし"}
            </span>
          </div>
        );
      })}
      {note ? <span className="text-2xs text-ink-faint">{note}</span> : null}
    </div>
  );
}

/**
 * ask_user の質問カード。回答待ちは 1 問ずつ出す入力 (ページ切り替え)、回答後は Q&A の記録として出す。
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
  const [page, setPage] = useState(0);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  const waiting = answerable && isPendingAskUserCard(card);
  const answers = recordAnswers(card, drafts, sent);
  const showForm = waiting && answers === undefined;
  const index = Math.min(page, Math.max(questions.length - 1, 0));

  const move = (delta: number): void => {
    setError(undefined);
    setPage(Math.min(Math.max(index + delta, 0), questions.length - 1));
  };

  const submit = async (next: AskUserAnswer[]): Promise<void> => {
    setSending(true);
    setError(undefined);
    const result = await onAnswer(card.id, next);
    setSending(false);
    if (result.ok) {
      // answers が届くまでは手元の入力を記録として見せる (tool_end は同じバッチの完了を待つことがある)
      setSent(true);
      return;
    }
    setError(result.error);
  };

  /** 次へ (最後の質問なら送信)。未回答を残したまま最後まで来たら、その質問へ戻す */
  const advance = (): void => {
    if (sending || !askUserDraftResolved(askUserDraftAt(drafts, index))) return;
    if (index < questions.length - 1) {
      move(1);
      return;
    }
    if (!askUserDraftsComplete(drafts)) {
      const first = nextUnresolvedAskUserIndex(drafts, index);
      if (first !== undefined) setPage(first);
      return;
    }
    void submit(askUserAnswersFromDrafts(drafts));
  };

  return (
    <section
      aria-label={showForm ? "エージェントからの質問" : "エージェントからの質問と回答"}
      className={cn(
        "grid min-w-0 overflow-hidden",
        showForm
          ? "gap-0 rounded-xl border border-line bg-panel"
          : "gap-3 rounded-xl border border-line/70 bg-soft/20 px-3 py-2.5",
      )}
    >
      {showForm ? (
        <AskUserForm
          questions={questions}
          drafts={drafts}
          index={index}
          sending={sending}
          error={error}
          compact={compact}
          onChange={(next) => {
            setError(undefined);
            setDrafts((current) => current.map((draft, i) => (i === index ? next : draft)));
          }}
          onMove={move}
          onSkip={() => {
            setError(undefined);
            setDrafts((current) =>
              current.map((draft, i) => (i === index ? { selected: [], text: "", skipped: true } : draft)),
            );
            if (index < questions.length - 1) move(1);
          }}
          onAdvance={advance}
          onClose={() => void submit(askUserAnswersClosing(drafts))}
        />
      ) : (
        <AskUserRecord
          questions={questions}
          answers={answers}
          compact={compact}
          note={
            answers !== undefined && answers.length > 0
              ? waiting
                ? "回答を送信しました。反映を待っています…"
                : undefined
              : "回答なしで終了"
          }
        />
      )}
    </section>
  );
}
