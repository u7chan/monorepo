import { useRef, useState } from "react";
import type { AgentSuggestion } from "../../types";
import { PlusIcon, TrashIcon } from "../icons";
import { SuggestionDeleteDialog } from "./SuggestionDeleteDialog";

/**
 * サーバー側の上限に合わせる。件数は見出しへ、文字数は各入力欄の隣へ現在値と上限で出し、
 * 件数の上限では「追加」を止める代わりに理由を説明行へ出す (見えない上限は、止められた理由も
 * 残り何文字なのかも読めない)。文字数は入力制限 (`maxLength`) と同じ生の長さで数える
 * (trim 後で数えると、空白を含むときに残量があるように見えて入力が止まる)。
 */
const SUGGESTION_LIMIT = 6;
const LABEL_MAX = 60;
const PROMPT_MAX = 500;

export const SUGGESTIONS_PANEL_HEADING = "定型プロンプト";
export const SUGGESTIONS_EMPTY_NOTE = "まだありません。追加すると、空の会話の最初の画面にボタンとして出ます。";

/**
 * 定型プロンプトのタブ。1 枚のパネルの中に行を積み、件数・文字数上限・空のときの案内を落とさない
 * (カードを行ごとに重ねると、面の枠が二重になって行の境目が読めなくなる)。
 */
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
  // 削除は確認の面を挟む。どの行を消すかは開いた時点の並びで持ち、確定まで配列を変えない
  const [removing, setRemoving] = useState<number | null>(null);
  const removingSuggestion = removing === null ? undefined : suggestions[removing];
  const panelRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  /** 確定後に焦点を移す先。消した行のボタンは unmount されるので、同じ位置に残った行 (無ければ追加) を使う */
  const focusAfterRemove = (index: number) => {
    requestAnimationFrame(() => {
      const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>("button[data-suggestion-remove]");
      const next = buttons?.[Math.min(index, (buttons?.length ?? 0) - 1)] ?? addRef.current;
      next?.focus();
    });
  };

  return (
    <div ref={panelRef} className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs text-ink-faint">
        <span className="font-semibold tracking-label uppercase">{SUGGESTIONS_PANEL_HEADING}</span>
        <span className="font-normal">
          {suggestions.length} / {SUGGESTION_LIMIT}
        </span>
      </div>
      {suggestions.length === 0 ? (
        <p className="text-2xs leading-4 text-ink-faint">{SUGGESTIONS_EMPTY_NOTE}</p>
      ) : (
        <div className="grid divide-y divide-line">
          {suggestions.map((suggestion, index) => (
            <div key={index} className="grid gap-1.5 py-2 first:pt-0 last:pb-0">
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-2xs text-ink-ghost tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted">{SUGGESTIONS_PANEL_HEADING}</span>
                <button
                  type="button"
                  data-suggestion-remove
                  onClick={() => setRemoving(index)}
                  aria-haspopup="dialog"
                  aria-label={`定型プロンプト${index + 1}を削除`}
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-danger/60 hover:text-danger"
                >
                  <TrashIcon />
                </button>
              </div>
              <label className="grid gap-1 text-2xs text-ink-soft">
                <span className="flex items-baseline justify-between gap-2">
                  <span>ラベル</span>
                  <span className="text-ink-ghost tabular-nums">
                    {suggestion.label.length} / {LABEL_MAX}
                  </span>
                </span>
                <input
                  className="field text-xs"
                  maxLength={LABEL_MAX}
                  placeholder="ラベル"
                  aria-label={`定型プロンプト${index + 1}のラベル`}
                  value={suggestion.label}
                  onChange={(e) => onChange(index, { label: e.currentTarget.value })}
                />
              </label>
              <label className="grid gap-1 text-2xs text-ink-soft">
                <span className="flex items-baseline justify-between gap-2">
                  <span>プロンプト</span>
                  <span className="text-ink-ghost tabular-nums">
                    {suggestion.prompt.length} / {PROMPT_MAX}
                  </span>
                </span>
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
              </label>
            </div>
          ))}
        </div>
      )}
      <button
        ref={addRef}
        type="button"
        disabled={atLimit}
        onClick={onAdd}
        className="inline-flex min-h-9 items-center justify-center gap-1.5 justify-self-start rounded-lg border border-dashed border-line px-3 text-1xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-55"
      >
        <PlusIcon />
        追加
      </button>
      <p className="text-2xs leading-relaxed text-ink-faint">
        空の会話の最初の画面にボタンとして出ます。未定義のエージェントではボタンが出ません。
      </p>
      {atLimit ? (
        <p role="status" className="text-2xs leading-relaxed text-ink-soft">
          上限の {SUGGESTION_LIMIT} 件です。追加するにはどれかを削除してください。
        </p>
      ) : null}
      {removing !== null && removingSuggestion !== undefined ? (
        <SuggestionDeleteDialog
          suggestion={removingSuggestion}
          index={removing + 1}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const index = removing;
            onRemove(index);
            setRemoving(null);
            focusAfterRemove(index);
          }}
        />
      ) : null}
    </div>
  );
}
