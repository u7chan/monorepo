import { useState } from "react";
import { MEMORY_NOTE } from "../lib/settingsNotes";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { AgentEditorForm } from "./agent-settings/AgentEditorForm";
import { AgentList } from "./agent-settings/AgentList";
import { SettingsDetailSheet } from "./SettingsDetailSheet";
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
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: MEMORY_NOTE, error: false });
  // compact は編集をシートへ出すため、開いているかを editingId とは別に持つ (editingId の null は「新規」も意味する)
  const [sheetOpen, setSheetOpen] = useState(false);
  const editingAgent = catalog.agents.find((agent) => agent.id === editingId);
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  const selectAgent = (nextId: string | null) => {
    setEditingId(nextId);
    // desktop は同じ場所にフォームが残るので、シートの状態は触らない (回転で勝手に開かないように)
    if (compact) setSheetOpen(true);
  };

  const startNewAgent = () => {
    setNoteText("新しいエージェントを作成します。");
    selectAgent(null);
  };

  const list = (
    <AgentList
      agents={catalog.agents}
      editingId={editingId}
      compact={compact}
      onSelect={selectAgent}
      onStartNew={startNewAgent}
    />
  );

  const editor = (
    <AgentEditorForm
      catalog={catalog}
      editingId={editingId}
      agent={editingAgent}
      selectedAgentId={agentId}
      modelOptions={modelOptions}
      defaultModel={defaultModel}
      defaultThinkingLevel={defaultThinkingLevel}
      showHeading={!compact}
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
        // 一覧がページ全高を使い、編集はシート (SettingsDetailSheet) へ出す
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
          title={editingAgent ? "エージェントを編集" : "新しいエージェント"}
          note={note}
          onClose={() => setSheetOpen(false)}
        >
          {editor}
        </SettingsDetailSheet>
      ) : null}
    </SettingsPageLayout>
  );
}
