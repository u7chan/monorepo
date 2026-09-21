import { useState } from "react";
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
  compact = false,
  onBack,
  onOpenNav,
}: AgentSettingsPageProps) {
  const agents = selectableAgents(catalog);
  const [editingId, setEditingId] = useState<string | null>(() => agentId || catalog.agents[0]?.id || null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  const editingAgent = agents.find((agent) => agent.id === editingId);
  // ビルトインは編集も削除もできないので、フォームの代わりに説明を出す (サーバーも 400 で拒否する)
  const builtinEditing =
    catalog.builtinAgent && catalog.builtinAgent.id === editingAgent?.id ? editingAgent : undefined;
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 下書きはページが持つ。理由は docs/ui-layout.md の「compact の詳細シート」を参照。
  // 参照が変わった編集対象・カタログを render 中に検出して初期化する (useEffect では古いフォームが 1 フレーム描画される)
  const [agentForm, setAgentForm] = useState<AgentForm>(() => agentFormOf(editingAgent));
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog }));
  if (formSource.editingId !== editingId || formSource.catalog !== catalog) {
    setFormSource({ editingId, catalog });
    setAgentForm(agentFormOf(editingAgent));
  }

  const selectAgent = (nextId: string | null) => {
    setEditingId(nextId);
    // desktop はページ内のフォームをそのまま使う (docs/ui-layout.md の「compact の詳細シート」)
    if (compact) setSheetOpen(true);
  };

  const startNewAgent = () => {
    setNoteText("新しいエージェントを作成します。");
    selectAgent(null);
  };

  const list = (
    <AgentList
      agents={agents}
      editingId={editingId}
      compact={compact}
      onSelect={selectAgent}
      onStartNew={startNewAgent}
    />
  );

  const editor = builtinEditing ? (
    <BuiltinAgentPanel agent={builtinEditing} variant={compact ? "sheet" : "page"} />
  ) : (
    <AgentEditorForm
      catalog={catalog}
      editingId={editingId}
      agent={editingAgent}
      form={agentForm}
      setForm={setAgentForm}
      variant={compact ? "sheet" : "page"}
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
      eyebrow="CONFIGURATION"
      title="エージェント"
      caption="会話の役割と、割り当てるスキルを定義します。"
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
      note={note}
    >
      {compact ? (
        <div className="grid min-h-0 min-w-0 grid-rows-1">{list}</div>
      ) : (
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] wide:grid-cols-[248px_minmax(0,1fr)] wide:grid-rows-1">
          {list}
          {editor}
        </div>
      )}
      {compact && sheetOpen ? (
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
