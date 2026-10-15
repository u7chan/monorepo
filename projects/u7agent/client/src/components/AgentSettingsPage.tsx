import { useState } from "react";
import { useFileSkills } from "../hooks/useFileSkills";
import { useWideLayout } from "../hooks/useLayoutMode";
import { selectableAgents } from "../lib/agentSelection";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { AgentEditorForm, agentFormOf, type AgentForm } from "./agent-settings/AgentEditorForm";
import { AgentList } from "./agent-settings/AgentList";
import { BuiltinAgentPanel } from "./agent-settings/BuiltinAgentPanel";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
import type { CatalogResponse, ModelOption, ThinkingLevel } from "../types";

export type AgentSettingsPageProps = SettingsPageProps & {
  catalog: CatalogResponse;
  agentId: string;
  /** agentId の正規化も行われる */
  refreshCatalog: () => Promise<CatalogResponse>;
  modelOptions: ModelOption[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
};

/** エージェント定義の管理ページ。dialog を被せないので、サイドバーの設定ナビと同時に見える */
export function AgentSettingsPage({
  catalog,
  agentId,
  refreshCatalog,
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
  const editingAgent = agents.find((agent) => agent.id === editingId);
  // ビルトインは編集も削除もできないので、フォームの代わりに説明を出す (サーバーも 400 で拒否する)
  const builtinEditing =
    catalog.builtinAgent && catalog.builtinAgent.id === editingAgent?.id ? editingAgent : undefined;
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 下書きはページが持つ。理由は docs/ui-layout.md の「設定の一覧と編集の境界」を参照。
  // 参照が変わった編集対象・カタログを render 中に検出して初期化する (useEffect では古いフォームが 1 フレーム描画される)
  const [agentForm, setAgentForm] = useState<AgentForm>(() => agentFormOf(editingAgent));
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog }));
  if (formSource.editingId !== editingId || formSource.catalog !== catalog) {
    setFormSource({ editingId, catalog });
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

  const list = <AgentList agents={agents} editingId={editingId} onSelect={selectAgent} onStartNew={startNewAgent} />;

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
