import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  SKILL_IMPORT_APPLIED_HEADING,
  SKILL_IMPORT_APPLIED_NEW_NOTE,
  SKILL_IMPORT_APPLIED_REPLACED_NOTE,
  SKILL_IMPORT_APPLYING_LABEL,
  SKILL_IMPORT_APPLY_LABEL,
  SKILL_IMPORT_CLOSE_LABEL,
  SKILL_IMPORT_DIALOG_TITLE,
  SKILL_IMPORT_FILE_LABEL,
  SKILL_IMPORT_NOTHING_NOTE,
  SKILL_IMPORT_PLANNING_NOTE,
  SKILL_IMPORT_PLAN_HEADING,
  SKILL_IMPORT_SELECT_ALL_LABEL,
  SKILL_IMPORT_SKIPPED_HEADING,
  SKILL_IMPORT_STATUS_LABEL,
  SKILL_IMPORT_STATUS_NOTE,
  skillImportPlanNote,
  skillImportSummary,
} from "../../lib/fileSkills";
import { replaceableSkillNames, skillImportCounts, type SkillImportFlow } from "../../lib/skillArchive";
import type { SandboxSkillImportPlanEntry, SandboxSkillsImportApply } from "../../types";

export type SkillImportDialogProps = {
  /** idle では開かない (mount しない) */
  flow: Exclude<SkillImportFlow, { status: "idle" }>;
  singleColumn?: boolean;
  onToggleReplace: (name: string) => void;
  onSetReplaceAll: (selected: boolean) => void;
  onApply: () => void;
  onClose: () => void;
};

/**
 * インポートの plan を見て、置き換えるスキルを選ぶ専用ダイアログ。共有の `DialogRequest` は confirm / prompt の
 * 2 種なので、選択を持つこの画面は `ProjectDialog` と同じ専用部品にする。モーダルの標準挙動 (背面の inert 化 /
 * Tab の拘束 / Escape での終了) と焦点の復帰に任せる。
 */
export function SkillImportDialog({
  flow,
  singleColumn = false,
  onToggleReplace,
  onSetReplaceAll,
  onApply,
  onClose,
}: SkillImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const busy = flow.status === "applying";
  const plan = flow.status === "review" || flow.status === "applying" ? flow.plan : null;
  const replace = flow.status === "review" || flow.status === "applying" ? flow.replace : [];
  const conflictNames = plan ? replaceableSkillNames(plan) : [];
  const selectedCount = conflictNames.filter((name) => replace.includes(name)).length;
  const counts = plan ? skillImportCounts(plan, replace) : null;
  const allSelected = conflictNames.length > 0 && selectedCount === conflictNames.length;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 初期焦点は取り消し側に置く (インポートする量を確認してから押させる)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // 一部だけ選んだ状態は「全選択」にしない (すべて選んだ / 選んでいない の 2 値では表せない)
  useEffect(() => {
    const input = selectAllRef.current;
    if (input) input.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (flow.status === "review") onApply();
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label={SKILL_IMPORT_DIALOG_TITLE}
      tabIndex={-1}
      // Escape はダイアログだけを閉じる (設定ページの「戻る」など背面の keydown へ届かせない)
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      // 適用中は結果を取りこぼさないよう閉じさせない (一覧の取り直しは適用後 1 回)
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      className={cn(
        "flex flex-col overflow-hidden border-line bg-panel p-0 text-ink",
        singleColumn
          ? "m-0 h-dvh max-h-none w-screen max-w-none rounded-none border-0"
          : "m-auto max-h-[min(88dvh,760px)] w-[min(560px,92vw)] rounded-xl border shadow-panel",
      )}
    >
      <header className="shrink-0 border-b border-line px-4 py-3.5">
        <div className="text-2xs font-semibold tracking-label text-ink-ghost uppercase">SKILLS</div>
        <h2 className="text-md font-semibold text-ink-strong">{SKILL_IMPORT_DIALOG_TITLE}</h2>
      </header>

      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 scrollbar-thin content-start gap-3 overflow-y-auto px-4 py-3.5 text-xs leading-relaxed">
          <div className="grid gap-0.5">
            <span className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
              {SKILL_IMPORT_FILE_LABEL}
            </span>
            <span className="min-w-0 truncate text-ink-strong" title={flow.fileName}>
              {flow.fileName}
            </span>
          </div>

          {flow.status === "planning" ? (
            <p className="break-words text-ink-soft">{SKILL_IMPORT_PLANNING_NOTE}</p>
          ) : null}
          {plan ? <p className="break-words text-ink-muted">{skillImportPlanNote(plan.entries, plan.bytes)}</p> : null}
          {counts ? (
            <p className="break-words text-ink-soft">{skillImportSummary(counts.imported, counts.replaced)}</p>
          ) : null}
          {counts && counts.imported === 0 ? (
            <p className="break-words text-warn">{SKILL_IMPORT_NOTHING_NOTE}</p>
          ) : null}

          {plan ? (
            <div className="grid gap-1">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
                  {SKILL_IMPORT_PLAN_HEADING}
                </h3>
                {conflictNames.length > 0 ? (
                  <label className="flex shrink-0 items-center gap-1.5 text-2xs text-ink-soft">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      className="accent-focus"
                      checked={allSelected}
                      disabled={busy}
                      onChange={(event) => onSetReplaceAll(event.currentTarget.checked)}
                    />
                    {SKILL_IMPORT_SELECT_ALL_LABEL}
                  </label>
                ) : null}
              </div>
              {plan.skills.map((entry) => (
                <SkillImportPlanRow
                  key={entry.name}
                  entry={entry}
                  selected={replace.includes(entry.name)}
                  busy={busy}
                  onToggle={onToggleReplace}
                />
              ))}
            </div>
          ) : null}

          {flow.status === "applied" ? <SkillImportResult result={flow.result} /> : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-quiet singleColumn:min-h-11"
          >
            {SKILL_IMPORT_CLOSE_LABEL}
          </button>
          {flow.status === "applied" ? null : (
            <button
              type="submit"
              disabled={busy || !counts || counts.imported === 0}
              className="btn-primary singleColumn:min-h-11"
            >
              {busy ? SKILL_IMPORT_APPLYING_LABEL : SKILL_IMPORT_APPLY_LABEL}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}

function SkillImportPlanRow({
  entry,
  selected,
  busy,
  onToggle,
}: {
  entry: SandboxSkillImportPlanEntry;
  selected: boolean;
  busy: boolean;
  onToggle: (name: string) => void;
}) {
  const name = <span className="min-w-0 flex-1 truncate text-xs text-ink-strong">{entry.name}</span>;
  return (
    <div className="grid gap-0.5 rounded-lg border border-line px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {/* 置き換えを選べるのは同名 (conflict) の行だけ。他の状態は行の注記どおりに扱う */}
        {entry.status === "conflict" ? (
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="checkbox"
              className="accent-focus"
              checked={selected}
              disabled={busy}
              onChange={() => onToggle(entry.name)}
            />
            {name}
          </label>
        ) : (
          name
        )}
        <span className="shrink-0 text-2xs text-ink-ghost">{SKILL_IMPORT_STATUS_LABEL[entry.status]}</span>
      </div>
      <p className={cn("text-2xs leading-4 break-words", entry.status === "invalid" ? "text-warn" : "text-ink-muted")}>
        {SKILL_IMPORT_STATUS_NOTE[entry.status]}
        {entry.reason ? ` ${entry.reason}` : ""}
      </p>
    </div>
  );
}

function SkillImportResult({ result }: { result: SandboxSkillsImportApply }) {
  return (
    <>
      <SkillImportResultGroup title={SKILL_IMPORT_APPLIED_HEADING} count={result.applied.length}>
        {result.applied.map((item) => (
          <div key={item.name} className="grid gap-0.5 rounded-lg border border-line px-2.5 py-2">
            <span className="min-w-0 truncate text-xs text-ink-strong">{item.name}</span>
            <p className="text-2xs leading-4 break-words text-ink-muted">
              {item.replaced ? SKILL_IMPORT_APPLIED_REPLACED_NOTE : SKILL_IMPORT_APPLIED_NEW_NOTE}
            </p>
          </div>
        ))}
      </SkillImportResultGroup>
      <SkillImportResultGroup title={SKILL_IMPORT_SKIPPED_HEADING} count={result.skipped.length}>
        {result.skipped.map((item) => (
          <div key={item.name} className="grid gap-0.5 rounded-lg border border-line px-2.5 py-2">
            <span className="min-w-0 truncate text-xs text-ink-strong">{item.name}</span>
            <p className="text-2xs leading-4 break-words text-ink-muted">{item.reason}</p>
          </div>
        ))}
      </SkillImportResultGroup>
    </>
  );
}

function SkillImportResultGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <h3 className="text-2xs font-semibold tracking-widest text-ink-faint uppercase">
        {title} {count}
      </h3>
      {children}
    </div>
  );
}
