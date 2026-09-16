import { useState, type FormEvent } from "react";
import { createAgent, deleteAgent, updateAgent } from "../../api";
import type { AgentDef, AgentSuggestion, Catalog, ModelOption, ModelRef, ThinkingLevel } from "../../types";
import { CheckIcon, TrashIcon } from "../icons";
import { AgentModelEffortFields } from "./AgentModelEffortFields";
import { SuggestionsEditor } from "./SuggestionsEditor";

type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  /** null は保存時に「指定解除」として送る */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  suggestions: AgentSuggestion[];
};

function agentFormOf(agent: AgentDef | undefined): AgentForm {
  return {
    name: agent?.name || "",
    description: agent?.description || "",
    systemPrompt: agent?.systemPrompt || "",
    skillIds: agent ? [...agent.skillIds] : [],
    model: agent?.model ? { ...agent.model } : null,
    thinkingLevel: agent?.thinkingLevel ?? null,
    // catalog のオブジェクトを直接編集しないよう、配列と要素をコピーして持つ
    suggestions: agent?.suggestions?.map((suggestion) => ({ ...suggestion })) ?? [],
  };
}

/**
 * 編集対象の state はこのフォームが持つ。参照が変わった編集対象・カタログを render 中に検出して初期化する
 * (useEffect では古いフォームが 1 フレーム描画される)。
 */
export function AgentEditorForm({
  catalog,
  editingId,
  agent,
  selectedAgentId,
  modelOptions,
  defaultModel,
  defaultThinkingLevel,
  refreshCatalog,
  onSelectAgent,
  onNote,
}: {
  catalog: Catalog;
  editingId: string | null;
  agent: AgentDef | undefined;
  selectedAgentId: string;
  modelOptions: ModelOption[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  refreshCatalog: () => Promise<Catalog>;
  onSelectAgent: (agentId: string | null) => void;
  onNote: (text: string, error?: boolean) => void;
}) {
  const [agentForm, setAgentForm] = useState<AgentForm>(() => agentFormOf(agent));
  // 値を初期化済みにしてから mount し、同じ値での再 render を避ける
  const [formSource, setFormSource] = useState(() => ({ editingId, catalog }));

  if (formSource.editingId !== editingId || formSource.catalog !== catalog) {
    setFormSource({ editingId, catalog });
    setAgentForm(agentFormOf(agent));
  }

  const saveAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = {
      name: agentForm.name,
      description: agentForm.description,
      systemPrompt: agentForm.systemPrompt,
      skillIds: agentForm.skillIds,
      // null はサーバー側で「指定解除」に正規化される。suggestions は空配列で解除
      model: agentForm.model,
      thinkingLevel: agentForm.thinkingLevel,
      suggestions: agentForm.suggestions,
    };
    try {
      const result = editingId ? await updateAgent(editingId, payload) : await createAgent(payload);
      onSelectAgent(result.agent.id);
      await refreshCatalog();
      onNote("エージェントを保存しました。適用するには新しい会話を開始してください。");
    } catch (error) {
      onNote(error instanceof Error ? error.message : String(error), true);
    }
  };

  const removeCurrentAgent = async () => {
    if (!editingId) return;
    if (!window.confirm("このエージェントを削除しますか？")) return;
    try {
      await deleteAgent(editingId);
      onSelectAgent(null);
      const next = await refreshCatalog();
      onSelectAgent(selectedAgentId || next.agents[0]?.id || null);
      onNote("エージェントを削除しました。");
    } catch (error) {
      // 最後のエージェントの削除などサーバー 400 のメッセージをそのまま出す
      onNote(error instanceof Error ? error.message : String(error), true);
    }
  };

  const toggleSkill = (skillId: string, checked: boolean) => {
    setAgentForm((prev) => ({
      ...prev,
      skillIds: checked ? [...prev.skillIds, skillId] : prev.skillIds.filter((id) => id !== skillId),
    }));
  };

  const addSuggestion = () => {
    setAgentForm((prev) => ({ ...prev, suggestions: [...prev.suggestions, { label: "", prompt: "" }] }));
  };

  const removeSuggestion = (index: number) => {
    setAgentForm((prev) => ({
      ...prev,
      suggestions: prev.suggestions.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const changeSuggestion = (index: number, patch: Partial<AgentSuggestion>) => {
    setAgentForm((prev) => ({
      ...prev,
      suggestions: prev.suggestions.map((suggestion, itemIndex) =>
        itemIndex === index ? { ...suggestion, ...patch } : suggestion,
      ),
    }));
  };

  return (
    <section className="min-h-0 min-w-0 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-4">
      <form onSubmit={saveAgent} className="mx-auto grid max-w-2xl gap-3">
        <div>
          <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">AGENT</div>
          <h3 className="text-sm font-semibold text-ink-strong">
            {agent ? "エージェントを編集" : "新しいエージェント"}
          </h3>
        </div>
        <label className="grid gap-1 text-1xs text-ink-soft">
          名前
          <input
            className="field text-xs"
            required
            maxLength={80}
            value={agentForm.name}
            // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
            onChange={(e) => {
              const name = e.currentTarget.value;
              setAgentForm((p) => ({ ...p, name }));
            }}
          />
        </label>
        <label className="grid gap-1 text-1xs text-ink-soft">
          説明
          <input
            className="field text-xs"
            maxLength={300}
            value={agentForm.description}
            onChange={(e) => {
              const description = e.currentTarget.value;
              setAgentForm((p) => ({ ...p, description }));
            }}
          />
        </label>
        <label className="grid gap-1 text-1xs text-ink-soft">
          役割 / 基本指示
          <textarea
            className="field min-h-28 text-xs leading-relaxed"
            rows={5}
            maxLength={8000}
            placeholder="空なら役割の指示なし (素の状態) で動きます"
            value={agentForm.systemPrompt}
            onChange={(e) => {
              const systemPrompt = e.currentTarget.value;
              setAgentForm((p) => ({ ...p, systemPrompt }));
            }}
          />
        </label>
        <AgentModelEffortFields
          model={agentForm.model}
          thinkingLevel={agentForm.thinkingLevel}
          modelOptions={modelOptions}
          defaultModel={defaultModel}
          defaultThinkingLevel={defaultThinkingLevel}
          onChangeModel={(model) => setAgentForm((prev) => ({ ...prev, model }))}
          onChangeThinkingLevel={(thinkingLevel) => setAgentForm((prev) => ({ ...prev, thinkingLevel }))}
        />
        <SuggestionsEditor
          suggestions={agentForm.suggestions}
          onChange={changeSuggestion}
          onRemove={removeSuggestion}
          onAdd={addSuggestion}
        />
        <div className="text-1xs text-ink-soft">割り当てるスキル</div>
        <div className="grid gap-1.5">
          {catalog.skills.length === 0 ? (
            <div className="text-1xs text-ink-faint">スキルがありません。「スキル」ページから作成できます。</div>
          ) : (
            catalog.skills.map((skill) => (
              <label key={skill.id} className="flex cursor-pointer items-start gap-2 rounded-lg bg-soft px-2.5 py-2">
                <input
                  type="checkbox"
                  checked={agentForm.skillIds.includes(skill.id)}
                  onChange={(e) => toggleSkill(skill.id, e.currentTarget.checked)}
                  className="mt-0.5 accent-focus"
                />
                <span className="min-w-0">
                  <span className="block text-xs text-ink">{skill.name}</span>
                  <small className="block text-2xs break-words text-ink-muted">{skill.description || ""}</small>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="flex gap-2 pt-1">
          {agent ? (
            <button
              type="button"
              onClick={() => void removeCurrentAgent()}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
            >
              <TrashIcon />
              削除
            </button>
          ) : null}
          <button type="submit" className="btn-primary flex-1">
            <CheckIcon />
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
