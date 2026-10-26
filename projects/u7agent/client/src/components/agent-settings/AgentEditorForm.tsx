import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { createAgent, deleteAgent, updateAgent } from "../../api";
import type { FileSkillsState } from "../../hooks/useFileSkills";
import { fileToAgentIcon } from "../../lib/agentIconFile";
import { groupFileSkills } from "../../lib/fileSkills";
import { agentDeleteConfirmRequest } from "../../lib/settingsConfirm";
import type {
  AgentDef,
  AgentSuggestion,
  CatalogResponse,
  CreateAgentBody,
  ModelOption,
  ModelRef,
  ThinkingLevel,
} from "../../types";
import { AgentIcon } from "../AgentIcon";
import { useConfirm } from "../ConfirmProvider";
import { CheckIcon, TrashIcon } from "../icons";
import { AgentModelEffortFields } from "./AgentModelEffortFields";
import { SkillSelector } from "./SkillSelector";
import { SuggestionsEditor } from "./SuggestionsEditor";
import { ToolSelector } from "./ToolSelector";

export type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  /**
   * 共通スキル (`.agents/skills`) の許可リスト。undefined = 未指定 (全可視で、保存ではキーを送らない)、
   * null = 全可視へ戻す送信専用の解除、配列 = 明示リスト ([] はすべて OFF)。
   * `agentFormOf` は null を作らない (解除は「すべて表示に戻す」の 1 経路だけ)。
   */
  commonSkillNames?: string[] | null;
  /**
   * 組み込みスキルの許可リスト。意味は `commonSkillNames` と同じ (undefined = 未指定で全部 ON、
   * null = 全部 ON へ戻す解除、配列 = 明示リストで [] はすべて OFF)。
   */
  builtinSkillNames?: string[] | null;
  /**
   * 自然文での発火を許すか。true = 現行どおり (既定)、false = 使用中のスキルを `/skill:` と
   * スキルボタンからのみ起動する。ビルトインは常に false (このフォームは出ない)。
   */
  allowNaturalInvocation: boolean;
  /**
   * ツールの許可リスト。意味は `commonSkillNames` と同じ (undefined = 未指定で全部 ON、null = 解除、
   * 配列 = 明示リストで [] はすべて OFF)。実効はアプリ側の可否との積 (docs/api-catalog.md)。
   */
  toolNames?: string[] | null;
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
    // [] は「すべて OFF」なので、undefined (未指定 = 全可視) へ潰さない
    commonSkillNames: agent?.commonSkillNames === undefined ? undefined : [...agent.commonSkillNames],
    builtinSkillNames: agent?.builtinSkillNames === undefined ? undefined : [...agent.builtinSkillNames],
    allowNaturalInvocation: agent?.allowNaturalInvocation !== false,
    toolNames: agent?.toolNames === undefined ? undefined : [...agent.toolNames],
    icon: agent?.icon ?? null,
    model: agent?.model ? { ...agent.model } : null,
    thinkingLevel: agent?.thinkingLevel ?? null,
    // catalog のオブジェクトを直接編集しないよう、配列と要素をコピーして持つ
    suggestions: agent?.suggestions?.map((suggestion) => ({ ...suggestion })) ?? [],
  };
}

/**
 * フォーム初期値の同一性。**参照ではなく内容**で比べるため、順序だけの更新や、確定後の取り直しが
 * 同じ内容で別のオブジェクトを返しても下書きを初期化しない（docs/frontend.md の Effect 契約）。
 */
export function agentFormKey(agent: AgentDef | undefined): string {
  return JSON.stringify(agentFormOf(agent));
}

/**
 * 保存ペイロード。`commonSkillNames` / `builtinSkillNames` / `toolNames` の undefined は `JSON.stringify` で
 * キーごと落ちて現状維持 (作成では未指定 = 全部 ON) になり、null は解除として送られる。これらは混同しない。
 */
export function agentPayloadOf(form: AgentForm): CreateAgentBody {
  return {
    name: form.name,
    description: form.description,
    systemPrompt: form.systemPrompt,
    commonSkillNames: form.commonSkillNames,
    builtinSkillNames: form.builtinSkillNames,
    allowNaturalInvocation: form.allowNaturalInvocation,
    toolNames: form.toolNames,
    // null はサーバー側で「指定解除」に正規化される。suggestions は空配列で解除
    icon: form.icon,
    model: form.model,
    thinkingLevel: form.thinkingLevel,
    suggestions: form.suggestions,
  };
}

/**
 * 許可リストのチェック切替。未指定 / 解除 (どちらも全部 ON) から外すときは「いま見えている一覧 − 対象」を
 * 明示リストへ固定する (あとから増えたスキルを勝手に許可しないため)。明示リストでは対象の名前だけを
 * 増減し、一覧に無い保存名 (削除・改名済み) は落とさない。
 */
function withAllowlistToggled(
  current: string[] | null | undefined,
  name: string,
  checked: boolean,
  visibleNames: string[],
): string[] {
  const names = current === undefined || current === null ? visibleNames : current;
  return checked ? (names.includes(name) ? names : [...names, name]) : names.filter((saved) => saved !== name);
}

/** 共通スキルのチェック切替。 */
export function withCommonSkillToggled(
  form: AgentForm,
  name: string,
  checked: boolean,
  visibleNames: string[],
): AgentForm {
  return { ...form, commonSkillNames: withAllowlistToggled(form.commonSkillNames, name, checked, visibleNames) };
}

/** 組み込みスキルのチェック切替。 */
export function withBuiltinSkillToggled(
  form: AgentForm,
  name: string,
  checked: boolean,
  visibleNames: string[],
): AgentForm {
  return { ...form, builtinSkillNames: withAllowlistToggled(form.builtinSkillNames, name, checked, visibleNames) };
}

/**
 * 「すべて表示に戻す」。null を送って解除する (undefined はキーごと落ちて現状維持になるため、
 * 保存済みの明示リストは戻せない)。
 */
export function withAllCommonSkillsVisible(form: AgentForm): AgentForm {
  return { ...form, commonSkillNames: null };
}

/** 「すべて使用に戻す」。null を送って解除する (undefined は現状維持なので明示リストは戻せない) */
export function withAllBuiltinSkillsEnabled(form: AgentForm): AgentForm {
  return { ...form, builtinSkillNames: null };
}

/**
 * 「すべて外す」。`[]` の明示リストにして、あとから同梱された分も自動では入れない
 * (docs/api-catalog.md#組み込みスキル)。
 */
export function withAllBuiltinSkillsDisabled(form: AgentForm): AgentForm {
  return { ...form, builtinSkillNames: [] };
}

/** ツールのチェック切替。規則はスキルの許可リストと同じ (未指定からは見えている一覧を固定する)。 */
export function withToolToggled(form: AgentForm, name: string, checked: boolean, visibleNames: string[]): AgentForm {
  return { ...form, toolNames: withAllowlistToggled(form.toolNames, name, checked, visibleNames) };
}

/** 「すべて使用に戻す」。null を送って解除する */
export function withAllToolsEnabled(form: AgentForm): AgentForm {
  return { ...form, toolNames: null };
}

/** 「すべて外す」。`[]` の明示リストにして、あとから増えたツールも自動では入れない */
export function withAllToolsDisabled(form: AgentForm): AgentForm {
  return { ...form, toolNames: [] };
}

export function AgentEditorForm({
  catalog,
  fileSkills,
  onReloadFileSkills,
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
  /** 共通スキル (`.agents/skills`) の取得状態。取得できないときは共通スキルの欄を出さず、下書きも変えない */
  fileSkills: FileSkillsState;
  /** 共通スキルを取得し直す。`SkillSelector` の取得失敗の表示から呼ぶ */
  onReloadFileSkills: () => void;
  editingId: string | null;
  agent: AgentDef | undefined;
  form: AgentForm;
  setForm: Dispatch<SetStateAction<AgentForm>>;
  /** page = ページ内の編集列、sheet = singleColumn のシート (docs/ui-layout.md) */
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
  const confirm = useConfirm();
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
    const payload = agentPayloadOf(form);
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
    if (!(await confirm(agentDeleteConfirmRequest(form.name)))) return;
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

  // 取得前・取得失敗では一覧が空になるが、欄を出さないのでこのハンドラは呼ばれない (下書きは変わらない)
  const visibleCommonNames =
    fileSkills.status === "ready" ? groupFileSkills(fileSkills.skills).common.map((skill) => skill.name) : [];

  const toggleCommonSkill = (name: string, checked: boolean) => {
    setForm((prev) => withCommonSkillToggled(prev, name, checked, visibleCommonNames));
  };

  // 組み込みはカタログ応答 (BFF の registry) から来るので、サンドボックスの取得に依らず一覧が揃う
  const visibleBuiltinNames = catalog.builtinSkills.map((skill) => skill.name);

  const toggleBuiltinSkill = (name: string, checked: boolean) => {
    setForm((prev) => withBuiltinSkillToggled(prev, name, checked, visibleBuiltinNames));
  };

  // ツールもカタログ応答から来る。実効の可否 (available) は保存値に影響させない (行の注記で伝える)
  const visibleToolNames = catalog.tools.map((tool) => tool.name);

  const toggleTool = (name: string, checked: boolean) => {
    setForm((prev) => withToolToggled(prev, name, checked, visibleToolNames));
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
              <div className="grid gap-2.5 @3xl:grid-cols-[minmax(0,1fr)_minmax(400px,460px)] @3xl:gap-x-6">
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
                          256×256 に縮小して保存します。未設定なら星のマークで表示します。
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
                </div>
                <div className="min-w-0">
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
                {/* 全幅にする。半幅では長い基本指示を書くのに狭い */}
                <label className="grid gap-1 text-1xs text-ink-soft @3xl:col-span-2">
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
              </div>
              <div className="grid gap-2.5 @3xl:grid-cols-2">
                <ToolSelector
                  tools={catalog.tools}
                  toolNames={form.toolNames}
                  onToggleTool={toggleTool}
                  onShowAllTools={() => setForm(withAllToolsEnabled)}
                  onDisableAllTools={() => setForm(withAllToolsDisabled)}
                />
                <SkillSelector
                  builtinSkills={catalog.builtinSkills}
                  fileSkills={fileSkills}
                  onReloadFileSkills={onReloadFileSkills}
                  commonSkillNames={form.commonSkillNames}
                  onToggleCommonSkill={toggleCommonSkill}
                  onShowAllCommonSkills={() => setForm(withAllCommonSkillsVisible)}
                  builtinSkillNames={form.builtinSkillNames}
                  onToggleBuiltinSkill={toggleBuiltinSkill}
                  onShowAllBuiltinSkills={() => setForm(withAllBuiltinSkillsEnabled)}
                  onDisableAllBuiltinSkills={() => setForm(withAllBuiltinSkillsDisabled)}
                  allowNaturalInvocation={form.allowNaturalInvocation}
                  onToggleNaturalInvocation={(allowNaturalInvocation) =>
                    setForm((prev) => ({ ...prev, allowNaturalInvocation }))
                  }
                />
                <div className="min-w-0 @3xl:col-span-2">
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
