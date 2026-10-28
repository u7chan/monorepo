import { useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { createAgent, deleteAgent, updateAgent } from "../../api";
import type { FileSkillsState } from "../../hooks/useFileSkills";
import { fileToAgentIcon } from "../../lib/agentIconFile";
import { allowlistCount, disableGroup, toggleAllowed } from "../../lib/agentAllowlist";
import {
  AGENT_TABS_ARIA_LABEL,
  AGENT_TAB_ASSIGN_LABEL,
  AGENT_TAB_LABELS,
  type AgentSettingsTab,
} from "../../lib/allowlistText";
import { groupFileSkills } from "../../lib/fileSkills";
import { groupTools } from "../../lib/tools";
import { agentDeleteConfirmRequest } from "../../lib/settingsConfirm";
import type {
  AgentDef,
  CatalogResponse,
  CreateAgentBody,
  ModelOption,
  ModelRef,
  ThinkingLevel,
  ToolGroup,
} from "../../types";
import { AgentIcon } from "../AgentIcon";
import { useConfirm } from "../ConfirmProvider";
import { CheckIcon, TrashIcon } from "../icons";
import { SettingsNoteRow } from "../SettingsNoteRow";
import { SettingsTabs } from "../SettingsTabs";
import { AgentModelEffortFields } from "./AgentModelEffortFields";
import { SkillSelector } from "./SkillSelector";
import { PromptSelector } from "./PromptSelector";
import { ToolSelector } from "./ToolSelector";

export type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  /**
   * 共通スキル (`.agents/skills`) の許可リスト。undefined = 未指定 (全可視で、保存ではキーを送らない)、
   * null = 全可視へ戻す送信専用の解除、配列 = 明示リスト ([] はすべて OFF)。
   * `agentFormOf` は null を作らない (解除は「すべて既定に戻す」の 1 経路だけ)。
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
  /** 参照するマスタの ID (並び = 表示順)。ラベル・本文の編集は独立した画面が持つ */
  promptIds: string[];
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
    // catalog の配列を直接編集しないよう、コピーして持つ
    promptIds: agent?.prompts?.map((prompt) => prompt.id) ?? [],
  };
}

/**
 * フォーム初期値の同一性。**参照ではなく内容**で比べるため、順序だけの更新や、確定後の取り直しが
 * 同じ内容で別のオブジェクトを返しても下書きを初期化しない（docs/frontend.md の Effect 契約）。
 */
export function agentFormKey(agent: AgentDef | undefined): string {
  return JSON.stringify(agentFormOf(agent));
}

/** 下書きが保存値と違うか (未保存チップ)。新規は空のフォームから離れたら未保存 */
export function isAgentFormDirty(form: AgentForm, agent: AgentDef | undefined): boolean {
  return JSON.stringify(form) !== agentFormKey(agent);
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
    // null はサーバー側で「指定解除」に正規化される。promptIds は空配列で全解除
    icon: form.icon,
    model: form.model,
    thinkingLevel: form.thinkingLevel,
    promptIds: form.promptIds,
  };
}

/** 共通スキルの切替。規則は lib/agentAllowlist.ts が正 */
export function withCommonSkillToggled(
  form: AgentForm,
  name: string,
  checked: boolean,
  visibleNames: string[],
): AgentForm {
  return { ...form, commonSkillNames: toggleAllowed(form.commonSkillNames, name, checked, visibleNames) };
}

/** 組み込みスキルの切替 */
export function withBuiltinSkillToggled(
  form: AgentForm,
  name: string,
  checked: boolean,
  visibleNames: string[],
): AgentForm {
  return { ...form, builtinSkillNames: toggleAllowed(form.builtinSkillNames, name, checked, visibleNames) };
}

/** ツールの切替 */
export function withToolToggled(form: AgentForm, name: string, checked: boolean, visibleNames: string[]): AgentForm {
  return { ...form, toolNames: toggleAllowed(form.toolNames, name, checked, visibleNames) };
}

/**
 * スキルタブの「すべて既定に戻す」。null を送って解除する (undefined はキーごと落ちて現状維持になるため、
 * 保存済みの明示リストは戻せない)。
 */
export function withAllSkillsReset(form: AgentForm): AgentForm {
  return { ...form, commonSkillNames: null, builtinSkillNames: null };
}

/** ツールタブの「すべて既定に戻す」 */
export function withAllToolsReset(form: AgentForm): AgentForm {
  return { ...form, toolNames: null };
}

/**
 * スキルのグループ単位「すべて外す」。対象グループの visible 名だけを除き、
 * 一覧に無い保存名と他グループ (組み込み ⇄ 共通) は残す。
 */
export function withSkillGroupDisabled(
  form: AgentForm,
  group: "builtin" | "common",
  visible: { common: readonly string[]; builtin: readonly string[] },
): AgentForm {
  if (group === "builtin") {
    return {
      ...form,
      builtinSkillNames: disableGroup(form.builtinSkillNames, visible.builtin, visible.builtin),
    };
  }
  return { ...form, commonSkillNames: disableGroup(form.commonSkillNames, visible.common, visible.common) };
}

/**
 * ツールのグループ単位「すべて外す」。`toolNames` は 1 本なので、開始集合は全ツールの visible 全件
 * (未指定のとき)。作業ツールを全 OFF にしてもアプリのツールは ON のまま残る。
 */
export function withToolGroupDisabled(
  form: AgentForm,
  group: ToolGroup,
  groups: { group: ToolGroup; names: readonly string[] }[],
  allVisibleNames: readonly string[],
): AgentForm {
  const target = groups.find((entry) => entry.group === group)?.names ?? [];
  return { ...form, toolNames: disableGroup(form.toolNames, target, allVisibleNames) };
}

/** テストと SkillSelector のために残す旧 API。すべて既定へ戻す (両方の許可リスト) */
export function withAllCommonSkillsVisible(form: AgentForm): AgentForm {
  return { ...form, commonSkillNames: null };
}

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

export function withAllToolsEnabled(form: AgentForm): AgentForm {
  return { ...form, toolNames: null };
}

/** 「すべて外す」。`[]` の明示リストにして、あとから増えたツールも自動では入れない */
export function withAllToolsDisabled(form: AgentForm): AgentForm {
  return { ...form, toolNames: [] };
}

/** 件数の表示 (タブのラベル)。検索中も未絞込の visible 行を数える */
function assignLabel(count: { used: number; total: number }): string {
  return `${AGENT_TAB_ASSIGN_LABEL} ${count.used}/${count.total}`;
}

export function AgentEditorForm({
  catalog,
  fileSkills,
  onReloadFileSkills,
  editingId,
  agent,
  form,
  setForm,
  selectedAgentId,
  modelOptions,
  defaultModel,
  defaultThinkingLevel,
  refreshCatalog,
  onSelectAgent,
  onNote,
  onDone,
  note,
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
  selectedAgentId: string;
  modelOptions: ModelOption[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  refreshCatalog: () => Promise<CatalogResponse>;
  onSelectAgent: (agentId: string | null) => void;
  onNote: (text: string, error?: boolean) => void;
  /** 保存 / 削除が成功したときに呼ぶ */
  onDone?: () => void;
  /** 並列表示ではページ下部に出すため渡さない (二重に積まない) */
  note?: { text: string; error: boolean };
}) {
  const confirm = useConfirm();
  const [tab, setTab] = useState<AgentSettingsTab>("basic");
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
  const commonSkills = fileSkills.status === "ready" ? groupFileSkills(fileSkills.skills).common : [];
  const visibleCommonNames = commonSkills.map((skill) => skill.name);
  // 組み込みはカタログ応答 (BFF の registry) から来るので、サンドボックスの取得に依らず一覧が揃う
  const visibleBuiltinNames = catalog.builtinSkills.map((skill) => skill.name);
  // ツールもカタログ応答から来る。実効の可否 (available) は保存値に影響させない (行の注記で伝える)
  const visibleToolNames = catalog.tools.map((tool) => tool.name);
  const skillCount = {
    used:
      allowlistCount(form.commonSkillNames, visibleCommonNames).used +
      allowlistCount(form.builtinSkillNames, visibleBuiltinNames).used,
    total: visibleCommonNames.length + visibleBuiltinNames.length,
  };
  const toolCount = allowlistCount(form.toolNames, visibleToolNames);

  const tabs = [
    { subsection: "basic" as const, label: AGENT_TAB_LABELS.basic },
    {
      subsection: "skills" as const,
      label: `${AGENT_TAB_LABELS.skills} ${assignLabel(skillCount)}`,
      ariaLabel: `スキル（${assignLabel(skillCount)}）`,
    },
    {
      subsection: "tools" as const,
      label: `${AGENT_TAB_LABELS.tools} ${assignLabel(toolCount)}`,
      ariaLabel: `ツール（${assignLabel(toolCount)}）`,
    },
    {
      subsection: "suggestions" as const,
      label: `${AGENT_TAB_LABELS.suggestions} ${form.promptIds.length}`,
      ariaLabel: `定型プロンプト（${form.promptIds.length} 件）`,
    },
  ];

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <form onSubmit={saveAgent} className="flex min-h-0 flex-1 flex-col">
        <SettingsTabs items={tabs} active={tab} onSelect={setTab} ariaLabel={AGENT_TABS_ARIA_LABEL} />
        <div className="min-h-0 flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-4 py-3">
          <div className="@container">
            <div className="mx-auto grid max-w-3xl content-start gap-3">
              {tab === "basic" ? (
                <div className="grid gap-3">
                  <section className="grid gap-2">
                    <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">プロフィール</h3>
                    <div className="grid gap-2 @2xl:grid-cols-2">
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
                    </div>
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
                          <p className="text-2xs leading-relaxed text-ink-faint">
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
                  </section>
                  <hr className="border-line" />
                  <section className="grid gap-2">
                    <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">モデル</h3>
                    <AgentModelEffortFields
                      model={form.model}
                      thinkingLevel={form.thinkingLevel}
                      modelOptions={modelOptions}
                      defaultModel={defaultModel}
                      defaultThinkingLevel={defaultThinkingLevel}
                      onChangeModel={(model) => setForm((prev) => ({ ...prev, model }))}
                      onChangeThinkingLevel={(thinkingLevel) => setForm((prev) => ({ ...prev, thinkingLevel }))}
                    />
                  </section>
                  <hr className="border-line" />
                  <section className="grid gap-2">
                    <h3 className="text-2xs font-semibold tracking-label text-ink-faint uppercase">役割 / 基本指示</h3>
                    <textarea
                      className="field min-h-36 text-xs leading-relaxed"
                      rows={6}
                      maxLength={8000}
                      aria-label="役割 / 基本指示"
                      placeholder="空なら役割の指示なし (素の状態) で動きます"
                      value={form.systemPrompt}
                      onChange={(e) => {
                        const systemPrompt = e.currentTarget.value;
                        setForm((p) => ({ ...p, systemPrompt }));
                      }}
                    />
                    <p className="text-2xs leading-relaxed text-ink-faint">
                      空にすると役割の指示なしで動きます。長い手順はスキルに分けると再利用できます。
                    </p>
                  </section>
                </div>
              ) : null}
              {tab === "skills" ? (
                <SkillSelector
                  builtinSkills={catalog.builtinSkills}
                  fileSkills={fileSkills}
                  onReloadFileSkills={onReloadFileSkills}
                  commonSkillNames={form.commonSkillNames}
                  onToggleCommonSkill={(name, checked) =>
                    setForm((prev) => withCommonSkillToggled(prev, name, checked, visibleCommonNames))
                  }
                  onDisableCommonSkills={() =>
                    setForm((prev) =>
                      withSkillGroupDisabled(prev, "common", {
                        common: visibleCommonNames,
                        builtin: visibleBuiltinNames,
                      }),
                    )
                  }
                  builtinSkillNames={form.builtinSkillNames}
                  onToggleBuiltinSkill={(name, checked) =>
                    setForm((prev) => withBuiltinSkillToggled(prev, name, checked, visibleBuiltinNames))
                  }
                  onDisableBuiltinSkills={() =>
                    setForm((prev) =>
                      withSkillGroupDisabled(prev, "builtin", {
                        common: visibleCommonNames,
                        builtin: visibleBuiltinNames,
                      }),
                    )
                  }
                  onResetSkills={() => setForm(withAllSkillsReset)}
                  allowNaturalInvocation={form.allowNaturalInvocation}
                  onToggleNaturalInvocation={(allowNaturalInvocation) =>
                    setForm((prev) => ({ ...prev, allowNaturalInvocation }))
                  }
                />
              ) : null}
              {tab === "tools" ? (
                <ToolSelector
                  tools={catalog.tools}
                  toolNames={form.toolNames}
                  onToggleTool={(name, checked) =>
                    setForm((prev) => withToolToggled(prev, name, checked, visibleToolNames))
                  }
                  onDisableToolGroup={(group) =>
                    setForm((prev) =>
                      withToolGroupDisabled(
                        prev,
                        group,
                        groupTools(catalog.tools).map((entry) => ({
                          group: entry.group,
                          names: entry.tools.map((tool) => tool.name),
                        })),
                        visibleToolNames,
                      ),
                    )
                  }
                  onResetTools={() => setForm(withAllToolsReset)}
                />
              ) : null}
              {tab === "suggestions" ? (
                <PromptSelector
                  prompts={catalog.prompts}
                  promptIds={form.promptIds}
                  onChange={(promptIds) => setForm((prev) => ({ ...prev, promptIds }))}
                />
              ) : null}
            </div>
          </div>
        </div>
        {note ? <SettingsNoteRow note={note} inset /> : null}
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
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
          <button type="submit" className="btn-primary ml-auto" disabled={iconBusy}>
            <CheckIcon />
            保存
          </button>
        </div>
      </form>
    </section>
  );
}
