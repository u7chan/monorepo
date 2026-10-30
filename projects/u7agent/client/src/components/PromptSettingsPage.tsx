import { useEffect, useRef, useState } from "react";
import { reorderPrompts } from "../api";
import { usePrompts } from "../hooks/usePrompts";
import { useWideLayout } from "../hooks/useLayoutMode";
import { reorderRows } from "../lib/agentReorder";
import { cn } from "../lib/cn";
import { MEMORY_NOTE, RELOAD_ABOVE_NOTE } from "../lib/settingsNotes";
import {
  emptyPromptDraftState,
  promptDraftChanged,
  promptDraftStateOf,
  promptMutationNote,
  promptPayloadOf,
  syncPromptDraft,
} from "../lib/promptSettings";
import { createReorderFlow, type ReorderNoteKind, type ReorderState } from "../lib/reorderFlow";
import { promptDeleteConfirmRequest } from "../lib/settingsConfirm";
import { useConfirm } from "./ConfirmProvider";
import { PromptDetail } from "./prompt-settings/PromptDetail";
import { PromptList } from "./prompt-settings/PromptList";
import { ReloadButton } from "./ReloadButton";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { TabToolbar } from "./TabToolbar";

/** 一覧を取得できていない状態の本文。0 件と混同させず、理由と取り直しの導線だけを出す */
function PromptLoadError({ message }: { message: string }) {
  return (
    <div className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <div className="mx-auto grid max-w-3xl gap-2 rounded-lg border border-line bg-soft p-3 text-xs text-ink-muted">
        <p role="alert" className="break-words">
          定型プロンプトを読み込めませんでした。{message}
        </p>
        <p className="text-2xs">{RELOAD_ABOVE_NOTE}。</p>
      </div>
    </div>
  );
}

/** 一覧と詳細のどちらを見せるか。並列表示では使わない */
type PromptView = "list" | "detail";

/** 並べ替えの失敗の文言。保存されたかどうかで伝えることを分ける（client/src/lib/reorderFlow.ts） */
function orderNoteText(kind: ReorderNoteKind, message: string): string {
  if (kind === "rejected") return `並び順を保存できませんでした。${message}`;
  if (kind === "unknown") {
    return `並び順を保存できたか確認できません。再読み込みするとサーバーの並びに合わせます。（${message}）`;
  }
  return `並び順は保存しましたが、${message}`;
}

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
  applyPromptOrder,
}: SettingsPageProps & {
  /** マスタの変更後にエージェントの解決済みの値を取り直す */
  refreshCatalog: () => Promise<unknown>;
  /** 並べ替えの確定順を、取り直しを待たずに共有カタログへ反映する */
  applyPromptOrder: (ids: readonly string[]) => void;
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

  // 取得に失敗しても直前の一覧は残る。初回の失敗 (空) は 0 件として出さない
  const list = prompts.state.prompts;
  const loadError = prompts.state.status === "error" ? prompts.state.message : undefined;

  // 並べ替えの下書きと保存。ドラッグの計算は lib/agentReorder、保存の手順は lib/reorderFlow が持ち、
  // ここは state への反映と文言だけを持つ（エージェントの一覧と同じ組み方）
  const [order, setOrder] = useState<ReorderState>({ draft: null, saving: false });
  const orderDeps = useRef({
    list,
    applyOrder: prompts.applyOrder,
    applyPromptOrder,
    refresh: prompts.refresh,
    setNoteText,
  });
  orderDeps.current = {
    list,
    applyOrder: prompts.applyOrder,
    applyPromptOrder,
    refresh: prompts.refresh,
    setNoteText,
  };
  const [orderFlow] = useState(() =>
    createReorderFlow({
      ids: () => orderDeps.current.list.filter((prompt) => prompt.kind === "custom").map((prompt) => prompt.id),
      save: async (ids) =>
        (await reorderPrompts(ids)).prompts.filter((prompt) => prompt.kind === "custom").map((prompt) => prompt.id),
      apply: (ids) => {
        orderDeps.current.applyOrder(ids);
        orderDeps.current.applyPromptOrder(ids);
      },
      refresh: () => orderDeps.current.refresh(),
      note: (kind, message) => orderDeps.current.setNoteText(orderNoteText(kind, message), true),
      onChange: setOrder,
    }),
  );
  // 取得した一覧が更新された = サーバーの正が届いた。結果不明のまま残した並びの下書きはここで捨てる
  // （エージェントのページと同じ規則。描画中の同期はフォームの初期化と同じ理由）
  const sourceListRef = useRef(list);
  if (sourceListRef.current !== list) {
    sourceListRef.current = list;
    orderFlow.settle();
  }
  // ドラッグ中は下書きの順で並べる。組み込みは先頭固定で、並べ替えの対象にしない
  const visibleList = order.draft ? reorderRows(list, order.draft) : list;
  const reorderIds = visibleList.filter((prompt) => prompt.kind === "custom").map((prompt) => prompt.id);

  // 並べて見せるときは先頭のマスタを選んでおく (右の面を空の新規フォームで埋めない)
  const [autoSelected, setAutoSelected] = useState(false);
  if (!autoSelected && !creating && list.length > 0) {
    setAutoSelected(true);
    if (!editingId) setEditingId(list[0].id);
  }
  const editingPrompt = editingId ? visibleList.find((prompt) => prompt.id === editingId) : undefined;

  // 下書きはページが持つ。失敗して保持した古い一覧や、遅れて届いた取得で、
  // 成立済みの保存値・編集中の入力を書き換えない (lib の syncPromptDraft が規則を持つ)
  const [draftState, setDraftState] = useState(emptyPromptDraftState);
  const nextDraftState = syncPromptDraft(draftState, {
    editingId,
    prompt: editingPrompt,
    // 取得に失敗している間の一覧は古い可能性があるため、内容の追随には使わない
    authoritative: prompts.state.status === "ready",
  });
  if (nextDraftState !== draftState) setDraftState(nextDraftState);
  const draft = draftState.draft;
  // 未保存の判定の基準は「最後に読み込んだ / 保存した内容」。成果の一覧が古くても誤って未保存にしない
  const dirty = promptDraftChanged(draftState.draft, draftState.key);

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
    const row = editingId
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-prompt-row="${CSS.escape(editingId)}"] button`)
      : undefined;
    (row ?? listRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [view, split, editingId]);

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
    try {
      const payload = promptPayloadOf(draft);
      const result = await prompts.save(editingId ?? undefined, payload);
      if (!result.ok) {
        // 失敗したら下書きを残す (保存できていない変更を成功扱いしない)
        setNoteText(result.message, true);
        return;
      }
      // 作成した ID を編集対象へ写す。同じフォームで続けて保存しても、次は更新になる。
      // 下書きの基準も保存した内容へ進め、失敗して保持した古い一覧で巻き戻さない
      setCreating(false);
      setEditingId(result.id);
      setDraftState(promptDraftStateOf(result.id, payload));
      // 保存そのものは成功している。取り直しの失敗だけを別の文で伝える
      const saved = promptMutationNote("saved", result.refreshError);
      setNoteText(saved.text, saved.error);
      if (!split) setView("list");
    } finally {
      setBusy(false);
    }
  };

  const removePrompt = async () => {
    if (!editingPrompt || busy) return;
    if (!(await confirm(promptDeleteConfirmRequest(editingPrompt.label)))) return;
    setBusy(true);
    try {
      const result = await prompts.remove(editingPrompt.id);
      if (!result.ok) {
        setNoteText(result.message, true);
        return;
      }
      setCreating(false);
      setEditingId(null);
      const deleted = promptMutationNote("deleted", result.refreshError);
      setNoteText(deleted.text, deleted.error);
      if (!split) setView("list");
    } finally {
      setBusy(false);
    }
  };

  const editor = (
    <PromptDetail
      prompt={editingPrompt}
      draft={draft}
      onDraftChange={(patch) => setDraftState((prev) => ({ ...prev, draft: { ...prev.draft, ...patch } }))}
      onSave={() => void savePrompt()}
      onDelete={() => void removePrompt()}
      saving={busy}
      note={split ? undefined : note}
    />
  );

  // 現在名 + ▾ のピッカー。一覧を並べている間は行の選択が切り替えを担うので出さない
  const pickerOptions: SelectMenuOption[] = visibleList.map((prompt) => ({
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
              value={editingId ?? ""}
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

  const listPane = (
    <PromptList
      prompts={visibleList}
      reorderIds={reorderIds}
      editingId={editingId}
      onSelect={selectPrompt}
      onStartNew={startNewPrompt}
      onReorder={(ids) => orderFlow.preview(ids)}
      onCommitOrder={() => void orderFlow.commit()}
      onCancelOrder={() => orderFlow.cancel()}
      reorderDisabled={order.saving}
    />
  );

  return (
    <SettingsPageLayout
      eyebrow="PROMPTS"
      title="定型プロンプト"
      caption="空の会話に出す定型文を、エージェントから独立したマスタとして管理します。"
      toolbar={
        <TabToolbar
          actions={
            <ReloadButton onClick={prompts.retry} disabled={prompts.state.status === "loading" || prompts.reloading}>
              再読み込み
            </ReloadButton>
          }
        />
      }
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={split || view === "list" ? note : undefined}
      collapseHeader={singleColumn && view === "detail"}
    >
      {loadError !== undefined && list.length === 0 ? (
        <PromptLoadError message={loadError} />
      ) : (
        <div
          className={cn(
            "grid min-h-0 min-w-0",
            loadError === undefined ? "grid-rows-1" : "grid-rows-[auto_minmax(0,1fr)]",
          )}
        >
          {loadError === undefined ? null : (
            // 前回の一覧は残っている。古いままであることと取り直しの導線を、0 件と混同させずに出す
            <p role="status" className="border-b border-line bg-soft px-4 py-2 text-2xs break-words text-warn-text">
              {loadError}（{RELOAD_ABOVE_NOTE}）
            </p>
          )}
          {split ? (
            <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
              {listPane}
              {detail}
            </div>
          ) : (
            <div className="grid min-h-0 min-w-0 grid-rows-1">
              {/* 一覧は隠れている間も mount したままにする (検索語とスクロールを詳細との往復で失わない) */}
              <div
                ref={listRef}
                hidden={view === "detail"}
                inert={view === "detail"}
                className="grid min-h-0 grid-rows-1"
              >
                {listPane}
              </div>
              {view === "detail" ? detail : null}
            </div>
          )}
        </div>
      )}
    </SettingsPageLayout>
  );
}
