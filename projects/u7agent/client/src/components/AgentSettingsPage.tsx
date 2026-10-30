import { useEffect, useRef, useState } from "react";
import { reorderAgents } from "../api";
import { useFileSkills } from "../hooks/useFileSkills";
import { useWideLayout } from "../hooks/useLayoutMode";
import { selectableAgents } from "../lib/agentSelection";
import { createReorderFlow, type ReorderNoteKind, type ReorderState } from "../lib/reorderFlow";
import { reorderRows } from "../lib/agentReorder";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import {
  AgentEditorForm,
  agentFormKey,
  agentFormOf,
  isAgentFormDirty,
  type AgentForm,
} from "./agent-settings/AgentEditorForm";
import { AgentList } from "./agent-settings/AgentList";
import { BuiltinAgentPanel } from "./agent-settings/BuiltinAgentPanel";
import { AgentIcon } from "./AgentIcon";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import type { CatalogResponse, ModelOption, ThinkingLevel } from "../types";

export type AgentSettingsPageProps = SettingsPageProps & {
  catalog: CatalogResponse;
  agentId: string;
  /** agentId の正規化も行われる */
  refreshCatalog: () => Promise<CatalogResponse>;
  /** 並べ替えの確定順を共有カタログへ即時反映する（client/src/lib/catalogStore.ts） */
  applyAgentOrder: (ids: readonly string[]) => void;
  modelOptions: ModelOption[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
};

/** 一覧と詳細のどちらを見せるか。並列表示では使わない */
type AgentView = "list" | "detail";

/** 並べ替えの失敗の文言。保存されたかどうかで伝えることを分ける（client/src/lib/reorderFlow.ts） */
function orderNoteText(kind: ReorderNoteKind, message: string): string {
  if (kind === "rejected") return `並び順を保存できませんでした。${message}`;
  if (kind === "unknown") {
    return `並び順を保存できたか確認できません。再読み込みするとサーバーの並びに合わせます。（${message}）`;
  }
  return `並び順は保存しましたが、一覧を取り直せませんでした。${message}`;
}

/**
 * エージェント定義の管理ページ。900px 以上の desktop では一覧と編集面を並べ、
 * それ以外 (singleColumn / 狭い desktop / 低い窓) では同じページの中で一覧 ⇄ 詳細を切り替える
 * (docs/ui-layout.md の「設定の一覧と編集の境界」)。
 */
export function AgentSettingsPage({
  catalog,
  agentId,
  refreshCatalog,
  applyAgentOrder,
  modelOptions,
  defaultModel,
  defaultThinkingLevel,
  singleColumn = false,
  onBack,
  onOpenNav,
}: AgentSettingsPageProps) {
  const agents = selectableAgents(catalog);
  // 並べるのは 900px 以上だけ。狭いときはページ内の view state で一覧と詳細を切り替える
  const wide = useWideLayout();
  const split = !singleColumn && wide;
  const [view, setView] = useState<AgentView>("list");
  const [editingId, setEditingId] = useState<string | null>(() => agentId || catalog.agents[0]?.id || null);
  // 共通スキル (`.agents/skills`) の一覧。エージェントへ割り当てる値の編集にだけ使う (読み取り専用)
  const fileSkills = useFileSkills();
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 並べ替えの下書きと保存。ドラッグの計算は lib/agentReorder、保存の手順は lib/reorderFlow が持ち、
  // ここは state への反映と文言だけを持つ（編集フォームの下書きをページが持つのと同じ理由）
  const [order, setOrder] = useState<ReorderState>({ draft: null, saving: false });
  const orderDeps = useRef({ catalogAgents: catalog.agents, applyAgentOrder, refreshCatalog, setNoteText });
  orderDeps.current = { catalogAgents: catalog.agents, applyAgentOrder, refreshCatalog, setNoteText };
  const [orderFlow] = useState(() =>
    createReorderFlow({
      ids: () => orderDeps.current.catalogAgents.map((agent) => agent.id),
      save: async (ids) => (await reorderAgents(ids)).agents.map((agent) => agent.id),
      apply: (ids) => orderDeps.current.applyAgentOrder(ids),
      refresh: () => orderDeps.current.refreshCatalog(),
      note: (kind, message) => orderDeps.current.setNoteText(orderNoteText(kind, message), true),
      onChange: setOrder,
    }),
  );
  // 共有カタログが更新された = サーバーの正が届いた。結果不明のまま残した並びの下書きはここで捨てる
  // （docs/ui-layout.md の「設定の一覧と編集の境界」）。描画中の同期はフォームの初期化と同じ理由
  const catalogRef = useRef(catalog);
  if (catalogRef.current !== catalog) {
    catalogRef.current = catalog;
    orderFlow.settle();
  }
  // ドラッグ中はカタログではなく下書きの順で並べる。ビルトインは先頭固定で、並べ替えの対象にしない
  const visibleAgents = order.draft ? reorderRows(agents, order.draft) : agents;
  const builtinId = catalog.builtinAgent?.id;
  const reorderIds = visibleAgents.filter((agent) => agent.id !== builtinId).map((agent) => agent.id);
  const editingAgent = visibleAgents.find((agent) => agent.id === editingId);
  // ビルトインは編集も削除もできないので、フォームの代わりに説明を出す (サーバーも 400 で拒否する)
  const builtinEditing =
    catalog.builtinAgent && catalog.builtinAgent.id === editingAgent?.id ? editingAgent : undefined;

  // 下書きはページが持つ。理由は docs/ui-layout.md の「設定の一覧と編集の境界」を参照。
  // 初期化は参照ではなく**編集対象の定義の内容**で判定する: 並び順だけの更新や、確定後の取り直し
  // （同じ内容でも別のオブジェクトが返る）で、入力中の未保存の下書きを消さない
  const [agentForm, setAgentForm] = useState<AgentForm>(() => agentFormOf(editingAgent));
  const [formSource, setFormSource] = useState(() => ({ editingId, key: agentFormKey(editingAgent) }));
  const nextFormKey = agentFormKey(editingAgent);
  if (formSource.editingId !== editingId || formSource.key !== nextFormKey) {
    setFormSource({ editingId, key: nextFormKey });
    setAgentForm(agentFormOf(editingAgent));
  }
  const dirty = !builtinEditing && isAgentFormDirty(agentForm, editingAgent);

  const selectAgent = (nextId: string | null) => {
    setEditingId(nextId);
    // 並べて見られないときだけ詳細へ切り替える (900px 以上はページ内のフォームをそのまま使う)
    if (!split) setView("detail");
  };

  const startNewAgent = () => {
    setNoteText("新しいエージェントを作成します。");
    selectAgent(null);
  };

  // 一覧 ⇄ 詳細の焦点。詳細では見出し (ヘッダ) へ、戻ったときは選択中の行へ移す (docs/ui-layout.md)
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousView = useRef<AgentView>(view);
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (split || previous === view) return;
    if (view === "detail") {
      detailRef.current?.focus();
      return;
    }
    const row = editingId
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-agent-row="${CSS.escape(editingId)}"] button`)
      : undefined;
    (row ?? listRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [view, split, editingId]);

  // 詳細の Escape は一覧へ戻す。capture で受けるのは、焦点が詳細の外へ落ちていても
  // App の「設定 → チャット」の Escape (window の bubble) より先に消費するため
  useEffect(() => {
    if (split || view !== "detail") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // モーダル / popover が開いている間は、そちらの標準の閉じ方に任せる
      if (document.querySelector("dialog[open], :popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      setView("list");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [split, view]);

  const list = (
    <AgentList
      agents={visibleAgents}
      builtinId={builtinId}
      reorderIds={reorderIds}
      editingId={editingId}
      onSelect={selectAgent}
      onStartNew={startNewAgent}
      onReorder={(ids) => orderFlow.preview(ids)}
      onCommitOrder={() => void orderFlow.commit()}
      onCancelOrder={() => orderFlow.cancel()}
      reorderDisabled={order.saving}
    />
  );

  const editor = builtinEditing ? (
    <BuiltinAgentPanel
      agent={builtinEditing}
      builtinSkills={catalog.builtinSkills}
      tools={catalog.tools}
      fileSkills={fileSkills.state}
    />
  ) : (
    <AgentEditorForm
      catalog={catalog}
      fileSkills={fileSkills.state}
      onReloadFileSkills={fileSkills.reload}
      editingId={editingId}
      agent={editingAgent}
      form={agentForm}
      setForm={setAgentForm}
      selectedAgentId={agentId}
      modelOptions={modelOptions}
      defaultModel={defaultModel}
      defaultThinkingLevel={defaultThinkingLevel}
      refreshCatalog={refreshCatalog}
      onSelectAgent={selectAgent}
      onNote={setNoteText}
      onDone={() => {
        if (!split) setView("list");
      }}
      note={split ? undefined : note}
    />
  );

  // 現在名 + ▾ のピッカー。戻る矢印だけが一覧へ戻り、ピッカーの選択は詳細の対象を切り替える
  const pickerOptions: SelectMenuOption[] = visibleAgents.map((agent) => ({
    value: agent.id,
    label: agent.name,
    description: agent.description || undefined,
    leading: <AgentIcon icon={agent.icon} variant="list" />,
  }));
  if (!editingAgent) {
    pickerOptions.unshift({ value: "", label: "新しいエージェント" });
  }
  const detail = (
    <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <SettingsDetailHeader
        ref={detailRef}
        back={split ? undefined : { label: "エージェント一覧へ", onClick: () => setView("list") }}
        // ページのヘッダを畳む面でも見出し (h2) を 1 つ残す
        heading={editingAgent?.name ?? "新しいエージェント"}
        title={
          // 一覧を並べて見せている間は、切り替えは一覧の行が担うのでピッカーを出さない (現在名だけを見出しにする)
          split ? (
            <span className="block truncate text-sm font-semibold text-ink-strong">
              {editingAgent?.name ?? "新しいエージェント"}
            </span>
          ) : (
            <SelectMenu
              options={pickerOptions}
              value={editingId ?? ""}
              label="エージェントを切り替える"
              triggerClassName="min-h-11"
              onChange={(value) => selectAgent(value || null)}
            />
          )
        }
        badge={
          dirty ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 px-1.5 text-2xs leading-5 text-warn-text">
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              未保存
            </span>
          ) : builtinEditing ? (
            // スキルの詳細と同じ印 (面のアクセント) にして、同じ「アプリが同梱するもの」を同じ見た目で示す
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
      eyebrow="AGENTS"
      title="エージェント"
      caption="会話の役割と、割り当てるスキルとツールを定義します。"
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={split || view === "list" ? note : undefined}
      // 詳細を開いている間はページの説明を落とし、戻る / ☰ の操作行だけにする
      collapseHeader={singleColumn && view === "detail"}
    >
      {split ? (
        <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
          {list}
          {detail}
        </div>
      ) : (
        <div className="grid min-h-0 min-w-0 grid-rows-1">
          {/* 一覧は隠れている間も mount したままにする (検索語とスクロールを詳細との往復で失わない) */}
          <div ref={listRef} hidden={view === "detail"} inert={view === "detail"} className="grid min-h-0 grid-rows-1">
            {list}
          </div>
          {view === "detail" ? detail : null}
        </div>
      )}
    </SettingsPageLayout>
  );
}
