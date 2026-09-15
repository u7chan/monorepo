import { useState } from "react";
import { DEFINITIONS_NOTE, DefinitionTransfer } from "./DefinitionTransfer";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { AgentEditorForm } from "./agent-settings/AgentEditorForm";
import { AgentList } from "./agent-settings/AgentList";
import type { Catalog, ModelOption, ThinkingLevel } from "../types";

export type AgentSettingsPageProps = SettingsPageProps & {
  catalog: Catalog;
  agentId: string;
  /** agentId の正規化も行われる */
  refreshCatalog: () => Promise<Catalog>;
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
  const [editingId, setEditingId] = useState<string | null>(() => agentId || catalog.agents[0]?.id || null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: DEFINITIONS_NOTE, error: false });
  const editingAgent = catalog.agents.find((agent) => agent.id === editingId);
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  const startNewAgent = () => {
    setEditingId(null);
    setNoteText("新しいエージェントを作成します。");
  };

  /** 新定義に無いエージェントを編集対象のまま残さない */
  const selectAfterImport = (next: Catalog) => {
    setEditingId(next.agents.some((agent) => agent.id === agentId) ? agentId : next.agents[0]?.id || null);
  };

  return (
    <SettingsPageLayout
      eyebrow="CONFIGURATION"
      title="エージェント"
      caption="会話の役割と、割り当てるスキルを定義します。"
      compact={compact}
      onOpenNav={onOpenNav}
      onBack={onBack}
      actions={
        <DefinitionTransfer
          catalog={catalog}
          refreshCatalog={refreshCatalog}
          onImported={selectAfterImport}
          onNote={setNoteText}
        />
      }
      note={note}
    >
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] wide:grid-cols-[248px_minmax(0,1fr)] wide:grid-rows-[minmax(0,1fr)]">
        <AgentList agents={catalog.agents} editingId={editingId} onSelect={setEditingId} onStartNew={startNewAgent} />
        <AgentEditorForm
          catalog={catalog}
          editingId={editingId}
          agent={editingAgent}
          selectedAgentId={agentId}
          modelOptions={modelOptions}
          defaultModel={defaultModel}
          defaultThinkingLevel={defaultThinkingLevel}
          refreshCatalog={refreshCatalog}
          onSelectAgent={setEditingId}
          onNote={setNoteText}
        />
      </div>
    </SettingsPageLayout>
  );
}
