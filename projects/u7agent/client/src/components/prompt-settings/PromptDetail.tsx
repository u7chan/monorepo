import type { FormEvent } from "react";
import type { PromptDef } from "../../types";
import {
  BUILTIN_PROMPT_READONLY_NOTE,
  PROMPT_LABEL_MAX,
  PROMPT_TEXT_MAX,
  promptDeleteBlockedReason,
  promptDraftError,
  promptUsageLabel,
  type PromptDraft,
} from "../../lib/promptSettings";
import { SettingsNoteRow } from "../SettingsNoteRow";
import { CheckIcon, TrashIcon } from "../icons";

/**
 * マスタ 1 件の面。自作だけ編集でき、組み込みは読み取り専用の閲覧にする (操作ごと出さない)。
 * 下書きはページが持つので、一覧へ戻っても未保存の入力は消えない。
 */
export function PromptDetail({
  prompt,
  draft,
  onDraftChange,
  onSave,
  onDelete,
  saving,
  note,
}: {
  /** undefined は新規作成 */
  prompt: PromptDef | undefined;
  draft: PromptDraft;
  onDraftChange: (patch: Partial<PromptDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  /** 並列表示ではページ下部に出すため渡さない (二重に積まない) */
  note?: { text: string; error: boolean };
}) {
  const builtin = prompt?.kind === "builtin";
  const error = promptDraftError(draft);
  // 使用中 / 組み込みは削除できない。理由は押せないボタンの隣に出す (押してから 409 で知らない)
  const deleteBlockedReason = prompt === undefined ? undefined : promptDeleteBlockedReason(prompt);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (builtin || error) return;
    onSave();
  };

  const usage = (
    <section className="grid gap-1.5">
      <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">使用先</h3>
      {prompt === undefined || prompt.usedBy.length === 0 ? (
        <p className="text-2xs leading-4 text-ink-faint">使用しているエージェントはありません。</p>
      ) : (
        <ul className="grid gap-1">
          {prompt.usedBy.map((entry) => (
            <li
              key={`${entry.builtin ? "builtin" : "agent"}:${entry.agentId}`}
              className="flex min-w-0 items-baseline gap-2 rounded-lg border border-line bg-soft px-2.5 py-1.5"
            >
              <span className="min-w-0 truncate text-1xs text-ink-strong">{promptUsageLabel(entry)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-2xs leading-relaxed text-ink-faint">
        使用中のマスタは削除できません。エージェントの「定型」タブで紐づけを解除すると削除できます。
      </p>
    </section>
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
          <div className="@container">
            <div className="mx-auto grid max-w-3xl content-start gap-3">
              {builtin ? (
                <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2">
                  <div className="grid gap-0.5">
                    <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">ラベル</span>
                    <span className="text-xs break-words text-ink-strong">{prompt?.label}</span>
                  </div>
                  <div className="grid gap-0.5">
                    <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">プロンプト</span>
                    <span className="text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-soft">
                      {prompt?.prompt}
                    </span>
                  </div>
                  <p className="border-t border-line pt-2 text-2xs leading-relaxed text-ink-faint">
                    {BUILTIN_PROMPT_READONLY_NOTE}
                  </p>
                </div>
              ) : (
                <>
                  <label className="grid gap-1 text-1xs text-ink-soft">
                    <span className="flex items-baseline justify-between gap-2">
                      <span>ラベル</span>
                      <span className="text-ink-ghost tabular-nums">
                        {draft.label.length} / {PROMPT_LABEL_MAX}
                      </span>
                    </span>
                    <input
                      className="field text-xs"
                      required
                      maxLength={PROMPT_LABEL_MAX}
                      placeholder="空の会話に出すボタンの文言"
                      value={draft.label}
                      onChange={(event) => {
                        const label = event.currentTarget.value;
                        onDraftChange({ label });
                      }}
                    />
                  </label>
                  <label className="grid gap-1 text-1xs text-ink-soft">
                    <span className="flex items-baseline justify-between gap-2">
                      <span>プロンプト</span>
                      <span className="text-ink-ghost tabular-nums">
                        {draft.prompt.length} / {PROMPT_TEXT_MAX}
                      </span>
                    </span>
                    <textarea
                      className="field field-sizing-content max-h-60 min-h-24 scrollbar-thin text-xs leading-relaxed"
                      rows={4}
                      required
                      maxLength={PROMPT_TEXT_MAX}
                      placeholder="送信する本文"
                      value={draft.prompt}
                      onChange={(event) => {
                        const promptText = event.currentTarget.value;
                        onDraftChange({ prompt: promptText });
                      }}
                    />
                  </label>
                  <p className="text-2xs leading-relaxed text-ink-faint">
                    選ぶと、空の会話の最初の画面にボタンとして出ます。押すとこの本文が入力欄のチップになります。
                  </p>
                </>
              )}
              <hr className="border-line" />
              {usage}
            </div>
          </div>
        </div>
        {note ? <SettingsNoteRow note={note} inset /> : null}
        {builtin ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            {prompt ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={saving || deleteBlockedReason !== undefined}
                title={deleteBlockedReason}
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <TrashIcon />
                削除
              </button>
            ) : null}
            {deleteBlockedReason ? (
              <p className="min-w-0 flex-1 text-2xs leading-relaxed break-words text-ink-faint">
                {deleteBlockedReason}
              </p>
            ) : null}
            <button
              type="submit"
              className="btn-primary ml-auto"
              disabled={saving || error !== undefined}
              // 押せない理由は欄の下ではなく入力の検証で示す (空のまま押したときに何が足りないか読める)
              title={error}
            >
              <CheckIcon />
              保存
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
