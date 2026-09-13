import { useMemo, useState, type FormEvent } from "react";
import { createAgent, deleteAgent, updateAgent } from "../api";
import { ALL_THINKING_LEVELS, effortLabel } from "../hooks/useAgentDesk";
import type { AgentSuggestion, Catalog, ModelOption, ModelRef, ThinkingLevel } from "../types";
import { DEFINITIONS_NOTE, DefinitionTransfer } from "./DefinitionTransfer";
import { SelectField } from "./SelectField";
import { SettingsPageLayout, type SettingsPageProps } from "./SettingsPageLayout";
import { CheckIcon, PlusIcon, TrashIcon } from "./icons";

/** サーバー側の上限に合わせる。これを超える行を保存時に黙って捨てないための事前制限。 */
const SUGGESTION_LIMIT = 6;

type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  /** null は「未指定」 (保存時は指定解除として送る) */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  suggestions: AgentSuggestion[];
};

const modelValueOf = (ref: ModelRef | null): string => (ref ? `${ref.provider}/${ref.id}` : "");

export type AgentSettingsPageProps = SettingsPageProps & {
  catalog: Catalog;
  /** 現在選択中のエージェント (編集初期選択と削除後のフォールバックに使う) */
  agentId: string;
  /** カタログ再読込 (保存・削除・インポート後)。agentId の正規化も行われる */
  refreshCatalog: () => Promise<Catalog>;
  /** モデル候補 (health より) */
  modelOptions: ModelOption[];
  /** アプリ既定モデル (provider/id) */
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
};

/**
 * エージェント定義の管理ページ。メイン領域に置く (dialog を被せない) ので、
 * サイドバーの設定ナビと同時に見える。一覧は左、編集フォームは右に組む。
 */
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

  const [agentForm, setAgentForm] = useState<AgentForm>({
    name: "",
    description: "",
    systemPrompt: "",
    skillIds: [],
    model: null,
    thinkingLevel: null,
    suggestions: [],
  });

  const editingAgent = catalog.agents.find((agent) => agent.id === editingId);
  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // 自分自身の state を render 中に調整し、古いフォームを DOM に commit しない (カタログ再読込時にも初期化する)。
  const [formSource, setFormSource] = useState<{ editingId: string | null; catalog: Catalog } | null>(null);
  if (formSource?.editingId !== editingId || formSource?.catalog !== catalog) {
    setFormSource({ editingId, catalog });
    setAgentForm({
      name: editingAgent?.name || "",
      description: editingAgent?.description || "",
      systemPrompt: editingAgent?.systemPrompt || "",
      skillIds: editingAgent ? [...editingAgent.skillIds] : [],
      model: editingAgent?.model ? { ...editingAgent.model } : null,
      thinkingLevel: editingAgent?.thinkingLevel ?? null,
      // catalog のオブジェクトを直接編集しないよう、配列と要素をコピーして持つ
      suggestions: editingAgent?.suggestions?.map((suggestion) => ({ ...suggestion })) ?? [],
    });
  }

  const startNewAgent = () => {
    setEditingId(null);
    setNoteText("新しいエージェントを作成します。");
  };

  /** 読み込んだ定義に合わせて選択を寄せる (新定義に無いエージェントを編集対象のまま残さない) */
  const selectAfterImport = (next: Catalog) => {
    setEditingId(next.agents.some((agent) => agent.id === agentId) ? agentId : next.agents[0]?.id || null);
  };

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
      setEditingId(result.agent.id);
      await refreshCatalog();
      setNoteText("エージェントを保存しました。適用するには新しい会話を開始してください。");
    } catch (error) {
      setNoteText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const removeCurrentAgent = async () => {
    if (!editingId) return;
    if (!window.confirm("このエージェントを削除しますか？")) return;
    try {
      await deleteAgent(editingId);
      setEditingId(null);
      const next = await refreshCatalog();
      setEditingId(agentId || next.agents[0]?.id || null);
      setNoteText("エージェントを削除しました。");
    } catch (error) {
      // 最後のエージェントの削除などサーバー 400 のメッセージをそのまま出す
      setNoteText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const toggleSkill = (skillId: string, checked: boolean) => {
    setAgentForm((prev) => ({
      ...prev,
      skillIds: checked ? [...prev.skillIds, skillId] : prev.skillIds.filter((id) => id !== skillId),
    }));
  };

  // --- エージェント定義の定型プロンプト ---

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

  // --- エージェント定義の Model / Effort ---

  const agentModelValue = modelValueOf(agentForm.model);
  // Model 未指定のときはアプリ既定モデルの対応段階を使い、既定も解決できないときだけ全段階を出す。
  const agentEffortModel = agentModelValue || defaultModel;
  const agentEffortOption = agentEffortModel
    ? modelOptions.find((option) => `${option.provider}/${option.id}` === agentEffortModel)
    : undefined;
  const agentThinkingLevels = agentEffortOption?.thinkingLevels ?? ALL_THINKING_LEVELS;
  const agentSupportsThinking = agentEffortOption?.supportsThinking ?? true;
  const agentModelMissing =
    Boolean(agentModelValue) && !modelOptions.some((option) => `${option.provider}/${option.id}` === agentModelValue);

  const agentModelChoices = useMemo(() => {
    const choices = modelOptions.map((option) => ({
      value: `${option.provider}/${option.id}`,
      label: `${option.name}（${option.provider}/${option.id}）`,
    }));
    if (agentModelValue && !choices.some((choice) => choice.value === agentModelValue)) {
      choices.push({ value: agentModelValue, label: `${agentModelValue}（利用不可）` });
    }
    return choices;
  }, [modelOptions, agentModelValue]);

  const agentEffortChoices = useMemo(() => {
    const levels = [...agentThinkingLevels];
    if (agentForm.thinkingLevel && !levels.includes(agentForm.thinkingLevel)) {
      levels.push(agentForm.thinkingLevel);
    }
    return levels;
  }, [agentThinkingLevels, agentForm.thinkingLevel]);

  const changeAgentModel = (value: string) => {
    if (!value) {
      setAgentForm((prev) => ({ ...prev, model: null }));
      return;
    }
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    setAgentForm((prev) => ({
      ...prev,
      model: { provider: value.slice(0, slash), id: value.slice(slash + 1) },
    }));
  };

  const itemClass = (active: boolean) =>
    [
      // 長い説明文が一覧のグリッド幅を押し広げないようにする。
      "flex min-w-0 w-full cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
      active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
    ].join(" ");

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
      {/* 幅が足りないときは一覧を上、フォームを下へ積む (wide 以上で左右 2 カラム) */}
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] wide:grid-cols-[248px_minmax(0,1fr)] wide:grid-rows-[minmax(0,1fr)]">
        <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
          <div className="flex items-baseline gap-1.5 border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-ink-faint">
            <span>エージェント一覧</span>
            <span className="font-normal">{catalog.agents.length}</span>
          </div>

          {/* 一覧: 画面の縦幅を使うため、件数が増えてもスクロールで耐える */}
          <div className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 max-h-[30vh] wide:max-h-none">
            <button
              type="button"
              onClick={startNewAgent}
              className="mb-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
            >
              <PlusIcon />
              新しいエージェント
            </button>
            <div className="grid min-w-0 gap-1">
              {catalog.agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setEditingId(agent.id)}
                  className={itemClass(editingId === agent.id)}
                >
                  <strong className="min-w-0 truncate text-xs text-ink">{agent.name}</strong>
                  <span className="min-w-0 truncate text-[10px] text-ink-muted">{agent.description || "説明なし"}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className="scrollbar-thin min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4 py-4">
          <form onSubmit={saveAgent} className="mx-auto grid max-w-2xl gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text">AGENT</div>
              <h3 className="text-sm font-semibold text-ink-strong">
                {editingAgent ? "エージェントを編集" : "新しいエージェント"}
              </h3>
            </div>
            <label className="grid gap-1 text-[11px] text-ink-soft">
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
            <label className="grid gap-1 text-[11px] text-ink-soft">
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
            <label className="grid gap-1 text-[11px] text-ink-soft">
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
            <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Model / Effort</div>
              <div className="grid gap-2 wide:grid-cols-2">
                <label className="grid gap-1 text-[11px] text-ink-soft">
                  Model
                  <SelectField
                    className="text-xs"
                    wrapperClassName="w-full"
                    aria-label="エージェントのモデル"
                    value={agentModelValue}
                    onChange={(e) => changeAgentModel(e.currentTarget.value)}
                  >
                    <option value="">未指定（アプリ既定）</option>
                    {agentModelChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </SelectField>
                </label>
                <label className="grid gap-1 text-[11px] text-ink-soft">
                  Effort
                  <SelectField
                    className="text-xs disabled:cursor-not-allowed disabled:opacity-55"
                    wrapperClassName="w-full"
                    aria-label="エージェントの Effort"
                    value={agentForm.thinkingLevel ?? ""}
                    onChange={(e) => {
                      const thinkingLevel = (e.currentTarget.value || null) as ThinkingLevel | null;
                      setAgentForm((p) => ({ ...p, thinkingLevel }));
                    }}
                  >
                    <option value="">
                      {defaultThinkingLevel ? `未指定（アプリ既定: ${effortLabel(defaultThinkingLevel)}）` : "未指定"}
                    </option>
                    {agentEffortChoices.map((level) => (
                      <option key={level} value={level} disabled={!agentSupportsThinking}>
                        {effortLabel(level)}
                      </option>
                    ))}
                  </SelectField>
                </label>
              </div>
              <p className="text-[10px] leading-relaxed text-ink-ghost">
                {agentModelMissing
                  ? "保存済みモデルは現在利用できません。別の候補を選ぶか未指定にすると回復できます。"
                  : !agentEffortOption
                    ? "利用可能なモデルを特定できないため、Effort は全段階を表示しています。使用モデルに応じて補正されます。"
                    : !agentSupportsThinking
                      ? "使用モデルは推論に対応していないため Effort を選べません。未指定に戻す操作は可能です。"
                      : "ここで指定した値は新しい会話の初期値になります。既存の会話には反映されません。"}
              </p>
            </div>
            <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">定型プロンプト</div>
              <div className="grid gap-2">
                {agentForm.suggestions.map((suggestion, index) => (
                  <div
                    key={index}
                    className="grid items-end gap-2 wide:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_auto]"
                  >
                    <label className="grid gap-1 text-[11px] text-ink-soft">
                      ラベル
                      <input
                        className="field text-xs"
                        maxLength={60}
                        aria-label={`定型プロンプト${index + 1}のラベル`}
                        value={suggestion.label}
                        onChange={(e) => changeSuggestion(index, { label: e.currentTarget.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-[11px] text-ink-soft">
                      プロンプト
                      <input
                        className="field text-xs"
                        maxLength={500}
                        aria-label={`定型プロンプト${index + 1}のプロンプト`}
                        value={suggestion.prompt}
                        onChange={(e) => changeSuggestion(index, { prompt: e.currentTarget.value })}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeSuggestion(index)}
                      aria-label={`定型プロンプト${index + 1}を削除`}
                      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-ink-soft transition-colors hover:border-danger/60 hover:text-danger"
                    >
                      <TrashIcon />
                      削除
                    </button>
                  </div>
                ))}
              </div>
              {/* 上限に達したら追加を止め、7 行目が保存時に黙って捨てられる状態を作らない */}
              <button
                type="button"
                disabled={agentForm.suggestions.length >= SUGGESTION_LIMIT}
                onClick={addSuggestion}
                className="inline-flex min-h-9 items-center justify-center gap-1.5 justify-self-start rounded-lg border border-dashed border-line px-3 text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-55"
              >
                <PlusIcon />
                追加
              </button>
              <p className="text-[10px] leading-relaxed text-ink-ghost">
                空の会話の最初の画面にボタンとして出ます。未定義のエージェントではボタンが出ません（最大 6 件）。
              </p>
            </div>
            <div className="text-[11px] text-ink-soft">割り当てるスキル</div>
            <div className="grid gap-1.5">
              {catalog.skills.length === 0 ? (
                <div className="text-[11px] text-ink-faint">
                  スキルがありません。「スキル」ページから作成できます。
                </div>
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
                      <small className="block break-words text-[10px] text-ink-muted">{skill.description || ""}</small>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="flex gap-2 pt-1">
              {editingAgent ? (
                <button
                  type="button"
                  onClick={() => void removeCurrentAgent()}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
                >
                  <TrashIcon />
                  削除
                </button>
              ) : null}
              <button
                type="submit"
                className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent transition-colors hover:brightness-110"
              >
                <CheckIcon />
                保存
              </button>
            </div>
          </form>
        </section>
      </div>
    </SettingsPageLayout>
  );
}
