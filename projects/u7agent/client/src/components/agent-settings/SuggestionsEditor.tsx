import type { AgentSuggestion } from "../../types";
import { PlusIcon, TrashIcon } from "../icons";

/**
 * サーバー側の上限に合わせる。件数は見出しへ、文字数は各入力欄の隣へ現在値と上限で出し、
 * 件数の上限では「追加」を止める代わりに理由を説明行へ出す (見えない上限は、止められた理由も
 * 残り何文字なのかも読めない)。
 */
const SUGGESTION_LIMIT = 6;
const LABEL_MAX = 60;
const PROMPT_MAX = 500;

export function SuggestionsEditor({
  suggestions,
  onChange,
  onRemove,
  onAdd,
}: {
  suggestions: AgentSuggestion[];
  onChange: (index: number, patch: Partial<AgentSuggestion>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  const atLimit = suggestions.length >= SUGGESTION_LIMIT;
  return (
    <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
        <span>定型プロンプト</span>
        <span className="font-normal">
          {suggestions.length} / {SUGGESTION_LIMIT}
        </span>
      </div>
      <div className="grid gap-1.5">
        {suggestions.map((suggestion, index) => (
          <div key={index} className="grid gap-1">
            <div className="flex items-center gap-1.5">
              <input
                className="field text-xs"
                maxLength={LABEL_MAX}
                placeholder="ラベル"
                aria-label={`定型プロンプト${index + 1}のラベル`}
                value={suggestion.label}
                onChange={(e) => onChange(index, { label: e.currentTarget.value })}
              />
              <span className="shrink-0 text-2xs text-ink-ghost tabular-nums">
                {suggestion.label.trim().length} / {LABEL_MAX}
              </span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`定型プロンプト${index + 1}を削除`}
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-danger/60 hover:text-danger"
              >
                <TrashIcon />
              </button>
            </div>
            {/* field-sizing 非対応のブラウザーでは rows=2 の高さのまま欄内スクロールになる (縮退) */}
            <textarea
              className="field field-sizing-content max-h-40 min-h-16 scrollbar-thin text-xs leading-relaxed"
              rows={2}
              maxLength={PROMPT_MAX}
              placeholder="プロンプト"
              aria-label={`定型プロンプト${index + 1}のプロンプト`}
              value={suggestion.prompt}
              onChange={(e) => onChange(index, { prompt: e.currentTarget.value })}
            />
            <div className="flex justify-end text-2xs text-ink-ghost tabular-nums">
              {suggestion.prompt.trim().length} / {PROMPT_MAX}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={atLimit}
        onClick={onAdd}
        className="inline-flex min-h-8 items-center justify-center gap-1.5 justify-self-start rounded-lg border border-dashed border-line px-3 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-55"
      >
        <PlusIcon />
        追加
      </button>
      <p className="text-2xs leading-relaxed text-ink-ghost">
        空の会話の最初の画面にボタンとして出ます。未定義のエージェントではボタンが出ません。
      </p>
      {atLimit ? (
        <p role="status" className="text-2xs leading-relaxed text-ink-soft">
          上限の {SUGGESTION_LIMIT} 件です。追加するにはどれかを削除してください。
        </p>
      ) : null}
    </div>
  );
}
