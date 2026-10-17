import { useRef, useState } from "react";
import { reorderAgents } from "../api";
import { useFileSkills } from "../hooks/useFileSkills";
import { useWideLayout } from "../hooks/useLayoutMode";
import { selectableAgents } from "../lib/agentSelection";
import { createAgentOrderFlow, type AgentOrderNoteKind, type AgentOrderState } from "../lib/agentOrder";
import { reorderRows } from "../lib/agentReorder";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { AgentEditorForm, agentFormKey, agentFormOf, type AgentForm } from "./agent-settings/AgentEditorForm";
import { AgentList } from "./agent-settings/AgentList";
import { BuiltinAgentPanel } from "./agent-settings/BuiltinAgentPanel";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
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

/** 並べ替えの失敗の文言。保存されたかどうかで伝えることを分ける（client/src/lib/agentOrder.ts） */
function orderNoteText(kind: AgentOrderNoteKind, message: string): string {
  if (kind === "rejected") return `並び順を保存できませんでした。${message}`;
  if (kind === "unknown") {
    return `並び順を保存できたか確認できません。再読み込みするとサーバーの並びに合わせます。（${message}）`;
  }
  return `並び順は保存しましたが、一覧を取り直せませんでした。${message}`;
}

/** エージェント定義の管理ページ。dialog を被せないので、サイドバーの設定ナビと同時に見える */
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
  // 一覧と編集を並べるのは 900px 以上だけ。狭い desktop と singleColumn は「一覧ページ + 全画面シート」に統一する
  // (一覧が何件でも編集面を削られない。docs/ui-layout.md の「設定の編集フォーム」)
  const wide = useWideLayout();
  const sheetMode = singleColumn || !wide;
  const [editingId, setEditingId] = useState<string | null>(() => agentId || catalog.agents[0]?.id || null);
  // 共通スキル (`.agents/skills`) の一覧。エージェントへ割り当てる値の編集にだけ使う (読み取り専用)
  const fileSkills = useFileSkills();
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 並べ替えの下書きと保存。ドラッグの計算は lib/agentReorder、保存の手順は lib/agentOrder が持ち、
  // ここは state への反映と文言だけを持つ（編集フォームの下書きをページが持つのと同じ理由）
  const [order, setOrder] = useState<AgentOrderState>({ draft: null, saving: false });
  const orderDeps = useRef({ catalogAgents: catalog.agents, applyAgentOrder, refreshCatalog, setNoteText });
  orderDeps.current = { catalogAgents: catalog.agents, applyAgentOrder, refreshCatalog, setNoteText };
  const [orderFlow] = useState(() =>
    createAgentOrderFlow({
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

  const selectAgent = (nextId: string | null) => {
    setEditingId(nextId);
    // 並べて見られないときだけシートを開く (900px 以上はページ内のフォームをそのまま使う)
    if (sheetMode) setSheetOpen(true);
  };

  const startNewAgent = () => {
    setNoteText("新しいエージェントを作成します。");
    selectAgent(null);
  };

  const list = (
    <AgentList
      agents={visibleAgents}
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
      variant={sheetMode ? "sheet" : "page"}
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
      variant={sheetMode ? "sheet" : "page"}
      selectedAgentId={agentId}
      modelOptions={modelOptions}
      defaultModel={defaultModel}
      defaultThinkingLevel={defaultThinkingLevel}
      refreshCatalog={refreshCatalog}
      onSelectAgent={selectAgent}
      onNote={setNoteText}
      onDone={() => setSheetOpen(false)}
    />
  );

  return (
    <SettingsPageLayout
      eyebrow="AGENTS"
      title="エージェント"
      caption="会話の役割と、割り当てるスキルを定義します。"
      singleColumn={singleColumn}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={note}
    >
      {sheetMode ? (
        <div className="grid min-h-0 min-w-0 grid-rows-1">{list}</div>
      ) : (
        <div className="grid min-h-0 min-w-0 wide:grid-cols-[248px_minmax(0,1fr)]">
          {list}
          {editor}
        </div>
      )}
      {sheetMode && sheetOpen ? (
        <SettingsDetailSheet
          eyebrow="AGENT"
          title={builtinEditing ? "ビルトインエージェント" : editingAgent ? "エージェントを編集" : "新しいエージェント"}
          note={note}
          onClose={() => setSheetOpen(false)}
        >
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
