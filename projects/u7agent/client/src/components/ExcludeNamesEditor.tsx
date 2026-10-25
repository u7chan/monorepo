import type { ReactNode } from "react";
import { archiveSettingsDirty, type ArchiveSettingsDraft } from "../lib/archiveSettings";
import { RELOAD_ABOVE_NOTE } from "../lib/settingsNotes";
import type { ArchiveSettingsResponse } from "../types";
import { CollapsibleNotice } from "./CollapsibleNotice";
import { PlusIcon, TrashIcon } from "./icons";

export type ExcludeNamesEditorProps = {
  /** 保存済みの設定（未取得は null） */
  settings: ArchiveSettingsResponse | null;
  /** 追加済みの下書き。入力途中の 1 件は `input` が持つ */
  draft: ArchiveSettingsDraft;
  /** 読み込み中 / 失敗の文言に使う対象名（例: ダウンロードの除外名） */
  subject: string;
  /** 規則の説明。画面ごとに文章が違う */
  rules: ReactNode;
  /** 取得・保存の注記。失敗のときだけ本文の枠に理由と再読み込みの案内を出す */
  note: { text: string; error: boolean };
  /** 一覧が空のときの警告（畳んだ 1 行） */
  emptySummary: string;
  /** 空の一覧の説明（展開した本文） */
  emptyBody: ReactNode;
  /** 入力の初期表示と aria-label */
  inputLabel: string;
  placeholder: string;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onRemove: (name: string) => void;
  /** 上部の補足（もう一方の設定への導線など） */
  hint?: ReactNode;
};

/**
 * 除外名の一覧エディタ。アーカイブ（ダウンロード）と共有（公開）で同じ形・同じ操作にし、
 * 規則・既定値・空の警告・補足だけを画面ごとに差し替える。ヘッダと操作行は呼び出し側が持つ。
 */
export function ExcludeNamesEditor({
  settings,
  draft,
  subject,
  note,
  rules,
  emptySummary,
  emptyBody,
  inputLabel,
  placeholder,
  input,
  onInputChange,
  onSubmit,
  onRemove,
  hint,
}: ExcludeNamesEditorProps) {
  // 保存したかどうかは一覧の保存値との差で決める（フッターの注記と同じ判定を使う）
  const dirty = settings ? archiveSettingsDirty(draft, settings) : false;
  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-3">
        {settings ? (
          <>
            {hint}

            <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
              <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">除外の規則</h3>
              {rules}
            </section>

            <section className="grid gap-2 rounded-lg border border-line bg-soft p-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <h3 className="flex min-w-0 flex-wrap items-center gap-1.5 text-2xs font-semibold tracking-label text-ink-faint uppercase">
                  除外する名前
                  {dirty ? (
                    <span className="rounded border border-danger/50 px-1.5 py-0.5 text-2xs font-normal tracking-normal text-danger-text normal-case">
                      未保存
                    </span>
                  ) : null}
                  <span className="rounded border border-line px-1.5 py-0.5 text-2xs font-normal tracking-normal text-ink-muted normal-case">
                    {settings.overridden ? "上書き中" : "既定の一覧を使用中"}
                  </span>
                </h3>
                <span className="text-2xs text-ink-muted">
                  {draft.excludeNames.length} / {settings.maxNames}
                </span>
              </div>

              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmit();
                }}
              >
                <input
                  className="field min-w-0 flex-1 text-xs"
                  type="text"
                  value={input}
                  placeholder={placeholder}
                  aria-label={inputLabel}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => onInputChange(event.currentTarget.value)}
                />
                <button type="submit" className="btn-quiet">
                  <PlusIcon />
                  追加
                </button>
              </form>

              {draft.excludeNames.length === 0 ? (
                <CollapsibleNotice summary={emptySummary}>{emptyBody}</CollapsibleNotice>
              ) : (
                <ul className="grid min-w-0 gap-0.5">
                  {draft.excludeNames.map((name) => (
                    <li
                      key={name}
                      className="-mx-1.5 flex min-h-6.5 min-w-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-hover"
                    >
                      <code className="min-w-0 flex-1 truncate text-xs text-ink" title={name}>
                        {name}
                      </code>
                      <button
                        type="button"
                        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-ink-soft transition-colors hover:bg-raised hover:text-danger"
                        aria-label={`${name} を除外から外す`}
                        title="除外から外す"
                        onClick={() => onRemove(name)}
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-2xs leading-relaxed text-ink-ghost">
                名前は 1 セグメント（<code>/</code>を含まない）で {settings.maxNameLength} 文字まで、
                {settings.maxNames} 件までです。既定の一覧は {settings.defaultExcludeNames.length} 件です。
              </p>
            </section>
          </>
        ) : (
          <div className="grid justify-items-start gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
            {note.error ? (
              <>
                <p role="alert">{subject}を読み込めませんでした。</p>
                <p>{RELOAD_ABOVE_NOTE}</p>
              </>
            ) : (
              <p role="status">{subject}を読み込んでいます。</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
