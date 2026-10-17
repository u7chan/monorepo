import type { FormEvent } from "react";
import {
  FILE_SKILL_BODY_LABEL,
  FILE_SKILL_CANCEL_LABEL,
  FILE_SKILL_CONFLICT_NOTE,
  FILE_SKILL_CREATE_HEADING,
  FILE_SKILL_DELETE_LABEL,
  FILE_SKILL_DESCRIPTION_LABEL,
  FILE_SKILL_EDIT_HEADING,
  FILE_SKILL_NAME_LABEL,
  FILE_SKILL_NAME_READONLY_NOTE,
  FILE_SKILL_RELOAD_LABEL,
  FILE_SKILL_SAVE_LABEL,
  FILE_SKILL_SAVE_LIMIT_NOTE,
} from "../../lib/fileSkills";
import type { FileSkillDraft } from "../../lib/fileSkillEditor";
import { CheckIcon, TrashIcon } from "../icons";
import { ReloadButton } from "../ReloadButton";

/** スキル名の上限 (SDK の規則)。作成時だけ入力する */
const NAME_MAX_LENGTH = 64;
/** 説明の上限 (SDK の validateDescription と同じ) */
const DESCRIPTION_MAX_LENGTH = 1024;

export function FileSkillEditorForm({
  mode,
  draft,
  setDraft,
  conflict,
  notice,
  variant,
  onSave,
  onCancel,
  onReload,
  onDelete,
}: {
  /** create = 新規 (名前を入力)、edit = 既存 (名前は表示のみ) */
  mode: "create" | "edit";
  draft: FileSkillDraft;
  setDraft: (patch: Partial<FileSkillDraft>) => void;
  /** 保存が版の不一致で止まった。下書きは保持したまま再読み込みを促す */
  conflict: boolean;
  /** 保存 / 作成に失敗した理由 (フォームの上に出す) */
  notice: string | null;
  variant: "page" | "sheet";
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  /** 競合したときに編集内容を取り直す (競合していないときは出さない) */
  onReload?: () => void;
  /** 既存スキルの削除 (確認は呼び出し側が取る)。新規では渡さない */
  onDelete?: () => void;
}) {
  const heading =
    variant === "page" ? (
      <div>
        <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">SKILL</div>
        <h3 className="text-sm font-semibold text-ink-strong">
          {mode === "create" ? FILE_SKILL_CREATE_HEADING : FILE_SKILL_EDIT_HEADING}
        </h3>
      </div>
    ) : null;

  const fields = (
    <>
      {heading}
      {notice ? <p className="text-1xs leading-relaxed break-words text-warn">{notice}</p> : null}
      {conflict && onReload ? (
        <div className="grid gap-1.5 rounded-lg border border-warn/50 bg-soft px-2.5 py-2">
          <p className="text-1xs leading-relaxed text-warn">{FILE_SKILL_CONFLICT_NOTE}</p>
          <ReloadButton size="sm" onClick={onReload} aria-label={FILE_SKILL_RELOAD_LABEL}>
            {FILE_SKILL_RELOAD_LABEL}
          </ReloadButton>
        </div>
      ) : null}
      <label className="grid gap-1 text-1xs text-ink-soft">
        {FILE_SKILL_NAME_LABEL}
        {mode === "create" ? (
          <input
            className="field text-xs"
            required
            maxLength={NAME_MAX_LENGTH}
            // 半角の小文字英数字とハイフンだけ (規則の正はサーバー側の SDK 検証)
            pattern="[a-z0-9-]+"
            value={draft.name}
            onChange={(event) => {
              // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
              const name = event.currentTarget.value;
              setDraft({ name });
            }}
          />
        ) : (
          <span className="text-xs break-words text-ink-strong">{draft.name}</span>
        )}
      </label>
      {mode === "edit" ? <p className="text-2xs leading-4 text-ink-faint">{FILE_SKILL_NAME_READONLY_NOTE}</p> : null}
      <label className="grid gap-1 text-1xs text-ink-soft">
        {FILE_SKILL_DESCRIPTION_LABEL}
        <input
          className="field text-xs"
          maxLength={DESCRIPTION_MAX_LENGTH}
          value={draft.description}
          onChange={(event) => {
            const description = event.currentTarget.value;
            setDraft({ description });
          }}
        />
      </label>
      <label className="grid gap-1 text-1xs text-ink-soft">
        {FILE_SKILL_BODY_LABEL}
        <textarea
          className="field min-h-36 text-xs leading-relaxed"
          rows={8}
          value={draft.body}
          onChange={(event) => {
            const body = event.currentTarget.value;
            setDraft({ body });
          }}
        />
      </label>
      <p className="text-2xs leading-4 text-ink-faint">{FILE_SKILL_SAVE_LIMIT_NOTE}</p>
    </>
  );

  const actions = (
    <>
      {mode === "edit" && onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
        >
          <TrashIcon />
          {FILE_SKILL_DELETE_LABEL}
        </button>
      ) : null}
      <button type="button" onClick={onCancel} className="btn-quiet">
        {FILE_SKILL_CANCEL_LABEL}
      </button>
      <button type="submit" className={variant === "page" ? "btn-primary flex-1" : "btn-primary ml-auto"}>
        <CheckIcon />
        {FILE_SKILL_SAVE_LABEL}
      </button>
    </>
  );

  // desktop のページは「本文の最後に操作行」、シートは「スクロール本文 + 下端に固定した操作行」で組む
  if (variant === "page") {
    return (
      <section className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
        <form onSubmit={onSave} className="mx-auto grid max-w-2xl gap-3">
          {fields}
          <div className="flex gap-2 pt-1">{actions}</div>
        </form>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form onSubmit={onSave} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
          <div className="mx-auto grid max-w-2xl gap-3">{fields}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">{actions}</div>
      </form>
    </section>
  );
}
