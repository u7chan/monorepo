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
    <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">定型プロンプト</div>
      <div className="grid gap-2">
        {suggestions.map((suggestion, index) => (
          <div key={index} className="grid items-end gap-2 wide:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_auto]">
            <label className="grid gap-1 text-[11px] text-ink-soft">
              ラベル
              <input
                className="field text-xs"
                maxLength={60}
                aria-label={`定型プロンプト${index + 1}のラベル`}
                value={suggestion.label}
                onChange={(e) => onChange(index, { label: e.currentTarget.value })}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-ink-soft">
              プロンプト
              <input
                className="field text-xs"
                maxLength={500}
                aria-label={`定型プロンプト${index + 1}のプロンプト`}
                value={suggestion.prompt}
                onChange={(e) => onChange(index, { prompt: e.currentTarget.value })}
              />
            </label>
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`定型プロンプト${index + 1}を削除`}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-soft transition-colors hover:border-danger/60 hover:text-danger"
            >
              <TrashIcon />
              削除
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={suggestions.length >= SUGGESTION_LIMIT}
        onClick={onAdd}
        className="inline-flex min-h-9 items-center justify-center gap-1.5 justify-self-start rounded-lg border border-dashed border-line px-3 text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-55"
      >
        <PlusIcon />
        追加
      </button>
      <p className="text-[10px] leading-relaxed text-ink-ghost">
        空の会話の最初の画面にボタンとして出ます。未定義のエージェントではボタンが出ません（最大 6 件）。
      </p>
    </div>
  );
}
