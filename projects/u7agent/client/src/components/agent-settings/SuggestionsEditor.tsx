import type { AgentSuggestion } from "../../types";
import { PlusIcon, TrashIcon } from "../icons";

/** サーバー側の上限に合わせる。これを超える行を保存時に黙って捨てないための事前制限。 */
const SUGGESTION_LIMIT = 6;

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
  return (
    <div className="grid gap-1.5 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
        <span>定型プロンプト</span>
        <span className="font-normal">{suggestions.length}</span>
      </div>
      <div className="grid gap-1.5">
        {suggestions.map((suggestion, index) => (
          <div key={index} className="grid gap-1">
            <div className="flex items-center gap-1.5">
              <input
                className="field text-xs"
                maxLength={60}
                placeholder="ラベル"
                aria-label={`定型プロンプト${index + 1}のラベル`}
                value={suggestion.label}
                onChange={(e) => onChange(index, { label: e.currentTarget.value })}
              />
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
              maxLength={500}
              placeholder="プロンプト"
              aria-label={`定型プロンプト${index + 1}のプロンプト`}
              value={suggestion.prompt}
              onChange={(e) => onChange(index, { prompt: e.currentTarget.value })}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={suggestions.length >= SUGGESTION_LIMIT}
        onClick={onAdd}
        className="inline-flex min-h-8 items-center justify-center gap-1.5 justify-self-start rounded-lg border border-dashed border-line px-3 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-55"
      >
        <PlusIcon />
        追加
      </button>
      <p className="text-2xs leading-relaxed text-ink-ghost">
        空の会話の最初の画面にボタンとして出ます。未定義のエージェントではボタンが出ません（最大 6 件）。
      </p>
    </div>
  );
}
