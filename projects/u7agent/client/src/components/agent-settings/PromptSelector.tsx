import type { PromptRef } from "../../types";
import { cn } from "../../lib/cn";
import {
  AGENT_PROMPT_LIMIT,
  AGENT_PROMPT_SELECT_EMPTY_NOTE,
  AGENT_PROMPT_SELECT_LIMIT_NOTE,
  atPromptLimit,
  withPromptMoved,
  withPromptRemoved,
  withPromptSelected,
} from "../../lib/promptSettings";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, PlusIcon } from "../icons";

export const AGENT_PROMPT_SELECT_HEADING = "定型プロンプト";
export const AGENT_PROMPT_SELECT_NOTE =
  "空の会話の最初の画面にボタンとして出ます。ラベルと本文は 設定 → 定型プロンプト で編集します。";

/**
 * エージェントの「定型」タブ。マスタの選択・解除・並べ替えだけを持ち、ラベル・本文の編集は
 * 独立したマスタ画面へ集約する (docs/ui-layout.md の「設定の一覧と編集の境界」)。
 */
export function PromptSelector({
  prompts,
  promptIds,
  onChange,
}: {
  /** 参照できるマスタ (カタログ応答の全件) */
  prompts: PromptRef[];
  /** 選択中の ID (並び = 表示順) */
  promptIds: string[];
  onChange: (promptIds: string[]) => void;
}) {
  const selected = promptIds.flatMap((id) => {
    const prompt = prompts.find((entry) => entry.id === id);
    return prompt ? [prompt] : [];
  });
  const available = prompts.filter((prompt) => !promptIds.includes(prompt.id));
  const atLimit = atPromptLimit(promptIds);

  return (
    <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
      <div className="flex items-baseline gap-1.5 text-2xs text-ink-faint">
        <span className="font-semibold tracking-label uppercase">{AGENT_PROMPT_SELECT_HEADING}</span>
        <span className="font-normal">
          {promptIds.length} / {AGENT_PROMPT_LIMIT}
        </span>
      </div>

      {selected.length === 0 ? (
        <p className="text-2xs leading-4 text-ink-faint">{AGENT_PROMPT_SELECT_EMPTY_NOTE}</p>
      ) : (
        <ol className="grid divide-y divide-line">
          {selected.map((prompt, index) => (
            <li key={prompt.id} className="flex min-w-0 items-center gap-1.5 py-1.5 first:pt-0 last:pb-0">
              <span className="shrink-0 text-2xs text-ink-ghost tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="min-w-0 truncate text-1xs text-ink-strong">{prompt.label}</span>
                  {prompt.kind === "builtin" ? (
                    <span className="shrink-0 rounded border border-accent/50 bg-accent-wash px-1 text-2xs leading-4 text-accent-text">
                      組み込み
                    </span>
                  ) : null}
                </span>
                <span className="line-clamp-1 min-w-0 text-2xs text-ink-faint">{prompt.prompt}</span>
              </span>
              <button
                type="button"
                aria-label={`${prompt.label} を上へ`}
                disabled={index === 0}
                onClick={() => onChange(withPromptMoved(promptIds, prompt.id, -1))}
                className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUpIcon />
              </button>
              <button
                type="button"
                aria-label={`${prompt.label} を下へ`}
                disabled={index === selected.length - 1}
                onClick={() => onChange(withPromptMoved(promptIds, prompt.id, 1))}
                className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowDownIcon />
              </button>
              <button
                type="button"
                aria-label={`${prompt.label} の紐づけを解除`}
                onClick={() => onChange(withPromptRemoved(promptIds, prompt.id))}
                className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-raised text-ink-soft transition-colors hover:border-danger/60 hover:text-danger"
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ol>
      )}

      {available.length > 0 ? (
        <div className="grid gap-1 border-t border-line pt-2">
          <span className="text-2xs text-ink-faint">追加できるマスタ</span>
          <ul className="grid gap-1">
            {available.map((prompt) => (
              <li key={prompt.id} className="flex min-w-0 items-center gap-1.5">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-1xs text-ink-soft">{prompt.label}</span>
                    {prompt.kind === "builtin" ? (
                      <span className="shrink-0 rounded border border-line px-1 text-2xs leading-4 text-ink-faint">
                        組み込み
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-1 min-w-0 text-2xs text-ink-faint">{prompt.prompt}</span>
                </span>
                <button
                  type="button"
                  aria-label={`${prompt.label} を追加`}
                  disabled={atLimit}
                  onClick={() => onChange(withPromptSelected(promptIds, prompt.id))}
                  className={cn(
                    "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-line bg-raised px-2 text-2xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text",
                    "disabled:cursor-not-allowed disabled:opacity-55",
                  )}
                >
                  <PlusIcon />
                  追加
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {atLimit ? (
        <p role="status" className="text-2xs leading-relaxed text-ink-soft">
          {AGENT_PROMPT_SELECT_LIMIT_NOTE} 減らすには紐づけを解除してください（マスタ自体は消えません）。
        </p>
      ) : null}
      <p className="text-2xs leading-relaxed text-ink-faint">{AGENT_PROMPT_SELECT_NOTE}</p>
    </div>
  );
}
