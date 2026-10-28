import { useEffect, useRef, useState } from "react";
import { usePrompts } from "../hooks/usePrompts";
import { useWideLayout } from "../hooks/useLayoutMode";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import {
  isPromptDraftDirty,
  promptDraftKey,
  promptDraftOf,
  promptPayloadOf,
  type PromptDraft,
} from "../lib/promptSettings";
import { promptDeleteConfirmRequest } from "../lib/settingsConfirm";
import { useConfirm } from "./ConfirmProvider";
import { PromptDetail } from "./prompt-settings/PromptDetail";
import { PromptList } from "./prompt-settings/PromptList";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

/** 一覧と詳細のどちらを見せるか。並列表示では使わない */
type PromptView = "list" | "detail";

/**
 * 設定 → 定型プロンプト (`/settings/prompts`)。マスタの一覧と、1 件の閲覧・編集を出す。
 * 幅の境界・下書きの持ち方・焦点・結果通知はエージェント / スキルの設定と同じ規則に従う
 * (docs/ui-layout.md の「設定の一覧と編集の境界」)。
 */
export function PromptSettingsPage({
  singleColumn = false,
  onBack,
  onOpenNav,
  refreshCatalog,
}: SettingsPageProps & {
  /** マスタの変更後にエージェントの解決済みの値を取り直す */
  refreshCatalog: () => Promise<unknown>;
}) {
  const prompts = usePrompts({ onChanged: refreshCatalog });
  const wide = useWideLayout();
  const split = !singleColumn && wide;
  const [view, setView] = useState<PromptView>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  // 新規の下書き中は、一覧が届いても選択を勝手に埋めない (空のフォームへ入力し始めた値を消さない)
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const setNoteText = (text: string, error = false) => setNote({ text, error });
  const [busy, setBusy] = useState(false);

  const list = prompts.state.status === "ready" ? prompts.state.prompts : [];
  // 並べて見せるときは先頭のマスタを選んでおく (右の面を空の新規フォームで埋めない)
  const [autoSelected, setAutoSelected] = useState(false);
  if (!autoSelected && !creating && list.length > 0) {
    setAutoSelected(true);
    if (!editingId) setEditingId(list[0].id);
  }
  const editingPrompt = editingId ? list.find((prompt) => prompt.id === editingId) : undefined;
  // 選択が一覧から消えた (削除・取得し直し) ら新規へ倒す。選択中の編集対象は消えたら諦める
  const effectiveId = editingPrompt ? editingId : null;

  // 下書きはページが持つ。初期化は編集対象の内容で判定し、一覧の取り直しで同じ内容が返っても消さない
  const [draft, setDraft] = useState<PromptDraft>(() => promptDraftOf(editingPrompt));
  const [draftSource, setDraftSource] = useState(() => ({
    editingId: effectiveId,
    key: promptDraftKey(promptDraftOf(editingPrompt)),
  }));
  const nextDraftKey = promptDraftKey(promptDraftOf(editingPrompt));
  if (draftSource.editingId !== effectiveId || draftSource.key !== nextDraftKey) {
    setDraftSource({ editingId: effectiveId, key: nextDraftKey });
    setDraft(promptDraftOf(editingPrompt));
  }
  const dirty = effectiveId !== null && isPromptDraftDirty(draft, editingPrompt);

  const selectPrompt = (nextId: string | null) => {
    setEditingId(nextId);
    if (!split) setView("detail");
  };

  const startNewPrompt = () => {
    setCreating(true);
    setNoteText("新しい定型プロンプトを作成します。");
    selectPrompt(null);
  };

  // 一覧 ⇄ 詳細の焦点。詳細では見出しへ、戻ったときは選択中の行へ移す (docs/ui-layout.md)
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousView = useRef<PromptView>(view);
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (split || previous === view) return;
    if (view === "detail") {
      detailRef.current?.focus();
      return;
    }
    const row = effectiveId
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-prompt-row="${CSS.escape(effectiveId)}"] button`)
      : undefined;
    (row ?? listRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [view, split, effectiveId]);

  // 詳細の Escape は一覧へ戻す。capture で受け、App の「設定 → チャット」より先に消費する
  useEffect(() => {
    if (split || view !== "detail") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open], :popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      setView("list");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [split, view]);

  const confirm = useConfirm();

  const savePrompt = async () => {
    if (busy) return;
    setBusy(true);
    const payload = promptPayloadOf(draft);
    const result = await prompts.save(effectiveId ?? undefined, payload);
    setBusy(false);
    if (!result.ok) {
      // 失敗したら下書きを残す (保存できていない変更を成功扱いしない)
      setNoteText(result.message, true);
      return;
    }
    setCreating(false);
    setNoteText("定型プロンプトを保存しました。");
    if (!split) setView("list");
  };

  const removePrompt = async () => {
    if (!editingPrompt || busy) return;
    if (!(await confirm(promptDeleteConfirmRequest(editingPrompt.label)))) return;
    setBusy(true);
    const result = await prompts.remove(editingPrompt.id);
    setBusy(false);
    if (!result.ok) {
      setNoteText(result.message, true);
      return;
    }
    setCreating(false);
    setEditingId(null);
    setNoteText("定型プロンプトを削除しました。");
    if (!split) setView("list");
  };

  const editor = (
    <PromptDetail
      prompt={editingPrompt}
      draft={draft}
      onDraftChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
      onSave={() => void savePrompt()}
      onDelete={() => void removePrompt()}
      saving={busy}
      note={split ? undefined : note}
    />
  );

  // 現在名 + ▾ のピッカー。一覧を並べている間は行の選択が切り替えを担うので出さない
  const pickerOptions: SelectMenuOption[] = list.map((prompt) => ({
    value: prompt.id,
    label: prompt.label,
    description: prompt.kind === "builtin" ? "組み込み" : prompt.prompt,
  }));
  if (!editingPrompt) pickerOptions.unshift({ value: "", label: "新しい定型プロンプト" });
  const detail = (
    <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <SettingsDetailHeader
        ref={detailRef}
        back={split ? undefined : { label: "定型プロンプト一覧へ", onClick: () => setView("list") }}
        heading={editingPrompt?.label ?? "新しい定型プロンプト"}
        title={
          split ? (
            <span className="block truncate text-sm font-semibold text-ink-strong">
              {editingPrompt?.label ?? "新しい定型プロンプト"}
            </span>
          ) : (
            <SelectMenu
              options={pickerOptions}
              value={effectiveId ?? ""}
              label="定型プロンプトを切り替える"
              triggerClassName="min-h-11"
              onChange={(value) => selectPrompt(value || null)}
            />
          )
        }
        badge={
          dirty ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 px-1.5 text-2xs leading-5 text-warn-text">
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              未保存
            </span>
          ) : editingPrompt?.kind === "builtin" ? (
            <span className="rounded border border-accent/50 bg-accent-wash px-1.5 text-2xs leading-4 text-accent-text">
              組み込み
            </span>
          ) : undefined
        }
      />
      {editor}
    </div>
  );

  return (
    <SettingsPageLayout
      eyebrow="PROMPTS"
      title="定型プロンプト"
      caption="空の会話に出す定型文を、エージェントから独立したマスタとして管理します。"
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={split || view === "list" ? note : undefined}
      collapseHeader={singleColumn && view === "detail"}
    >
      {split ? (
        <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
          <PromptList prompts={list} editingId={effectiveId} onSelect={selectPrompt} onStartNew={startNewPrompt} />
          {detail}
        </div>
      ) : (
        <div className="grid min-h-0 min-w-0 grid-rows-1">
          {/* 一覧は隠れている間も mount したままにする (検索語とスクロールを詳細との往復で失わない) */}
          <div ref={listRef} hidden={view === "detail"} inert={view === "detail"} className="grid min-h-0 grid-rows-1">
            <PromptList prompts={list} editingId={effectiveId} onSelect={selectPrompt} onStartNew={startNewPrompt} />
          </div>
          {view === "detail" ? detail : null}
        </div>
      )}
    </SettingsPageLayout>
  );
}
