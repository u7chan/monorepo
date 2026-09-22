import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { createAgent, deleteAgent, updateAgent } from "../../api";
import { fileToAgentIcon } from "../../lib/agentIconFile";
import type { AgentDef, AgentSuggestion, CatalogResponse, ModelOption, ModelRef, ThinkingLevel } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { CheckIcon, TrashIcon } from "../icons";
import { AgentModelEffortFields } from "./AgentModelEffortFields";
import { SkillSelector } from "./SkillSelector";
import { SuggestionsEditor } from "./SuggestionsEditor";

export type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  /** data URL。null は未設定で、保存時は「指定解除」として送る */
  icon: string | null;
  /** null は保存時に「指定解除」として送る */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  suggestions: AgentSuggestion[];
};

/** 下書き (AgentForm) はページが持つ。渡した編集対象から初期値を作る */
export function agentFormOf(agent: AgentDef | undefined): AgentForm {
  return {
    name: agent?.name || "",
    description: agent?.description || "",
    systemPrompt: agent?.systemPrompt || "",
    skillIds: agent ? [...agent.skillIds] : [],
    icon: agent?.icon ?? null,
    model: agent?.model ? { ...agent.model } : null,
    thinkingLevel: agent?.thinkingLevel ?? null,
    // catalog のオブジェクトを直接編集しないよう、配列と要素をコピーして持つ
    suggestions: agent?.suggestions?.map((suggestion) => ({ ...suggestion })) ?? [],
  };
}

export function AgentEditorForm({
  catalog,
  editingId,
  agent,
  form,
  setForm,
  variant,
  selectedAgentId,
  modelOptions,
  defaultModel,
  defaultThinkingLevel,
  refreshCatalog,
  onSelectAgent,
  onNote,
  onDone,
}: {
  catalog: CatalogResponse;
  editingId: string | null;
  agent: AgentDef | undefined;
  form: AgentForm;
  setForm: Dispatch<SetStateAction<AgentForm>>;
  /** page = ページ内の編集列、sheet = compact のシート (docs/ui-layout.md) */
  variant: "page" | "sheet";
  selectedAgentId: string;
  modelOptions: ModelOption[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  refreshCatalog: () => Promise<CatalogResponse>;
  onSelectAgent: (agentId: string | null) => void;
  onNote: (text: string, error?: boolean) => void;
  /** 保存 / 削除が成功したときに呼ぶ */
  onDone?: () => void;
}) {
  const showHeading = variant === "page";
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [iconBusy, setIconBusy] = useState(false);
  // 変換中に編集対象が変わるかを await の後に判定する (新しい下書きを古い選択の結果で汚さない)
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;

  const pickIcon = async (file: File) => {
    const target = editingId;
    setIconBusy(true);
    try {
      const icon = await fileToAgentIcon(file);
      if (editingIdRef.current !== target) return;
      setForm((prev) => ({ ...prev, icon }));
    } catch (error) {
      onNote(error instanceof Error ? error.message : String(error), true);
    } finally {
      setIconBusy(false);
    }
  };

  const saveAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = {
      name: form.name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      skillIds: form.skillIds,
      // null はサーバー側で「指定解除」に正規化される。suggestions は空配列で解除
      icon: form.icon,
      model: form.model,
      thinkingLevel: form.thinkingLevel,
      suggestions: form.suggestions,
    };
    try {
      const result = editingId ? await updateAgent(editingId, payload) : await createAgent(payload);
      onSelectAgent(result.agent.id);
      await refreshCatalog();
      onNote("エージェントを保存しました。適用するには新しい会話を開始してください。");
      onDone?.();
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
      onDone?.();
    } catch (error) {
      // 削除を拒否されたときはサーバーの文言をそのまま出す
      onNote(error instanceof Error ? error.message : String(error), true);
    }
  };

  const toggleSkill = (skillId: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      skillIds: checked ? [...prev.skillIds, skillId] : prev.skillIds.filter((id) => id !== skillId),
    }));
  };

  const addSuggestion = () => {
    setForm((prev) => ({ ...prev, suggestions: [...prev.suggestions, { label: "", prompt: "" }] }));
  };

  const removeSuggestion = (index: number) => {
    setForm((prev) => ({
      ...prev,
      suggestions: prev.suggestions.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const changeSuggestion = (index: number, patch: Partial<AgentSuggestion>) => {
    setForm((prev) => ({
      ...prev,
      suggestions: prev.suggestions.map((suggestion, itemIndex) =>
        itemIndex === index ? { ...suggestion, ...patch } : suggestion,
      ),
    }));
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form onSubmit={saveAgent} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
          <div className="@container">
            <div className="mx-auto grid max-w-5xl gap-2.5">
              {showHeading ? (
                <div>
                  <div className="text-2xs font-semibold tracking-label text-accent-text uppercase">AGENT</div>
                  <h3 className="text-sm font-semibold text-ink-strong">
                    {agent ? "エージェントを編集" : "新しいエージェント"}
                  </h3>
                </div>
              ) : null}
              <div className="grid gap-2.5 @3xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] @3xl:gap-x-6">
                {/* content-start: 列の高さは隣の列に合わせて伸びるが、中の行まで伸ばすと入力欄の高さが変わってしまう */}
                <div className="grid min-w-0 content-start gap-3">
                  <label className="grid gap-1 text-1xs text-ink-soft">
                    名前
                    <input
                      className="field text-xs"
                      required
                      maxLength={80}
                      value={form.name}
                      // updater は遅延評価されるため、イベントの値は updater の外で読む (currentTarget は null になる)
                      onChange={(e) => {
                        const name = e.currentTarget.value;
                        setForm((p) => ({ ...p, name }));
                      }}
                    />
                  </label>
                  <label className="grid gap-1 text-1xs text-ink-soft">
                    説明
                    <input
                      className="field text-xs"
                      maxLength={300}
                      value={form.description}
                      onChange={(e) => {
                        const description = e.currentTarget.value;
                        setForm((p) => ({ ...p, description }));
                      }}
                    />
                  </label>
                  <div className="grid gap-1 text-1xs text-ink-soft">
                    アイコン
                    <div className="flex items-center gap-3">
                      <AgentIcon icon={form.icon ?? undefined} variant="preview" />
                      <div className="grid gap-1.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="btn-quiet"
                            disabled={iconBusy}
                            onClick={() => iconInputRef.current?.click()}
                          >
                            {iconBusy ? "変換中…" : "画像を選ぶ"}
                          </button>
                          {form.icon ? (
                            <button
                              type="button"
                              className="btn-quiet"
                              disabled={iconBusy}
                              onClick={() => setForm((prev) => ({ ...prev, icon: null }))}
                            >
                              解除
                            </button>
                          ) : null}
                        </div>
                        <p className="text-2xs leading-relaxed text-ink-ghost">
                          256×256 に縮小して保存します。未設定なら ✦ で表示します。
                        </p>
                      </div>
                    </div>
                    <input
                      ref={iconInputRef}
                      type="file"
                      accept="image/*"
                      tabIndex={-1}
                      aria-hidden="true"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        // 同じファイルを選び直せるよう、選択を毎回リセットする
                        event.currentTarget.value = "";
                        if (file) void pickIcon(file);
                      }}
                    />
                  </div>
                  <label className="grid gap-1 text-1xs text-ink-soft">
                    役割 / 基本指示
                    <textarea
                      className="field min-h-36 text-xs leading-relaxed"
                      rows={6}
                      maxLength={8000}
                      placeholder="空なら役割の指示なし (素の状態) で動きます"
                      value={form.systemPrompt}
                      onChange={(e) => {
                        const systemPrompt = e.currentTarget.value;
                        setForm((p) => ({ ...p, systemPrompt }));
                      }}
                    />
                  </label>
                  <AgentModelEffortFields
                    model={form.model}
                    thinkingLevel={form.thinkingLevel}
                    modelOptions={modelOptions}
                    defaultModel={defaultModel}
                    defaultThinkingLevel={defaultThinkingLevel}
                    onChangeModel={(model) => setForm((prev) => ({ ...prev, model }))}
                    onChangeThinkingLevel={(thinkingLevel) => setForm((prev) => ({ ...prev, thinkingLevel }))}
                  />
                </div>
                <div className="grid min-w-0 content-start gap-2.5">
                  <SkillSelector
                    skills={catalog.skills}
                    builtinSkills={catalog.builtinSkills}
                    selectedIds={form.skillIds}
                    onToggle={toggleSkill}
                  />
                  <SuggestionsEditor
                    suggestions={form.suggestions}
                    onChange={changeSuggestion}
                    onRemove={removeSuggestion}
                    onAdd={addSuggestion}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          {agent ? (
            <>
              <button
                type="button"
                onClick={() => void removeCurrentAgent()}
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
              >
                <TrashIcon />
                削除
              </button>
            </>
          ) : null}
          <button type="submit" className="btn-primary ml-auto" disabled={iconBusy}>
            <CheckIcon />
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
