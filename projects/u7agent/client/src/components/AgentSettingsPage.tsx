import { useRef, useState } from "react";
import { reorderAgents } from "../api/catalog";
import { useFileSkills } from "../hooks/useFileSkills";
import { useWideLayout } from "../hooks/useLayoutMode";
import { useLatestRef } from "../hooks/useLatestRef";
import { useListDetailPane } from "../hooks/useListDetailPane";
import { selectableAgents } from "../lib/agentSelection";
import { createReorderFlow, type ReorderNoteKind, type ReorderState } from "../lib/reorderFlow";
import { reorderRows } from "../lib/listReorder";
import { orderFailureNoteText } from "../lib/orderNote";
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

/** 並べ替えの失敗の文言。保存できなかった場合の共通の文に、取り直しだけの文を足す（client/src/lib/orderNote.ts） */
function orderNoteText(kind: ReorderNoteKind, message: string): string {
  if (kind === "refresh") return `並び順は保存しましたが、一覧を取り直せませんでした。${message}`;
  return orderFailureNoteText(kind, message);
}

/**
 * エージェント定義の管理ページ。900px 以上の desktop は一覧と編集面を並べ、それ以外は同じページで
 * 一覧 ⇄ 詳細を切り替える (docs/ui-layout.md の「設定の一覧と編集の境界」)。
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
  // 並べるのは 900px 以上だけ。狭いときはページ内の面で一覧と詳細を切り替える
  const wide = useWideLayout();
  const split = !singleColumn && wide;
  const [editingId, setEditingId] = useState<string | null>(() => agentId || catalog.agents[0]?.id || null);
  const pane = useListDetailPane({ split, selectedId: editingId, rowAttribute: "data-agent-row" });
  // 共通スキル (`.agents/skills`) の一覧。エージェントへ割り当てる値の編集にだけ使う (読み取り専用)
  const fileSkills = useFileSkills();
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 並べ替えの下書きと保存。ドラッグの計算は lib/listReorder、保存の手順は lib/reorderFlow が持ち、
  // ここは state への反映と文言だけを持つ（編集フォームの下書きをページが持つのと同じ理由）
  const [order, setOrder] = useState<ReorderState>({ draft: null, saving: false });
  const orderDeps = useLatestRef({ catalogAgents: catalog.agents, applyAgentOrder, refreshCatalog, setNoteText });
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

  /**
   * 下書きはページが持つ (docs/ui-layout.md の「設定の一覧と編集の境界」)。初期化の判定は参照ではなく
   * 編集対象の内容で行い、並び替えや同じ内容の取り直しで未保存の下書きを消さない。
   */
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
    pane.openDetail();
  };

  const startNewAgent = () => {
    setNoteText("新しいエージェントを作成します。");
    selectAgent(null);
  };

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
        pane.backToList();
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
        ref={pane.detailRef}
        back={split ? undefined : { label: "エージェント一覧へ", onClick: pane.backToList }}
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
      note={split || pane.view === "list" ? note : undefined}
      // 詳細を開いている間はページの説明を落とし、戻る / ☰ の操作行だけにする
      collapseHeader={singleColumn && pane.view === "detail"}
    >
      {split ? (
        <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
          {list}
          {detail}
        </div>
      ) : (
        <div className="grid min-h-0 min-w-0 grid-rows-1">
          {/* 一覧は隠れている間も mount したままにする (検索語とスクロールを詳細との往復で失わない) */}
          <div
            ref={pane.listRef}
            hidden={pane.view === "detail"}
            inert={pane.view === "detail"}
            className="grid min-h-0 grid-rows-1"
          >
            {list}
          </div>
          {pane.view === "detail" ? detail : null}
        </div>
      )}
    </SettingsPageLayout>
  );
}
