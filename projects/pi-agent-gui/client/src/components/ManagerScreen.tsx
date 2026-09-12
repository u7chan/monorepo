import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createAgent,
  createSkill,
  deleteAgent,
  deleteSkill,
  replaceCatalog,
  updateAgent,
  updateSkill,
} from "../api";
import { ALL_THINKING_LEVELS, effortLabel } from "../hooks/useAgentDesk";
import type { Catalog, ModelOption, ModelRef, ThinkingLevel } from "../types";

type EditingType = "agent" | "skill";

export type ManagerScreenProps = {
  onClose: () => void;
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
  /** モバイルの compact layout (幅 900px 未満では stacked になるため、高さも使って詰める) */
  compact?: boolean;
};

const DEFAULT_NOTE = "変更はこのサーバーのメモリ内だけに保存されます。再起動するとサンプルに戻ります。";

type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  /** null は「未指定」 (保存時は指定解除として送る) */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
};

const modelValueOf = (ref: ModelRef | null): string =>
  ref ? `${ref.provider}/${ref.id}` : "";

/**
 * エージェント / スキル定義の管理画面。フルスクリーンの独立画面にして一覧の縦幅を確保し、
 * 種別 (エージェント / スキル) はタブで切り替える。
 */
export function ManagerScreen({
  onClose,
  catalog,
  agentId,
  refreshCatalog,
  modelOptions,
  defaultModel,
  defaultThinkingLevel,
  compact = false,
}: ManagerScreenProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** 開く前にフォーカスしていた要素 (閉じたときに戻す) */
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editingType, setEditingType] = useState<EditingType>("agent");
  const [editingId, setEditingId] = useState<string | null>(() => agentId || catalog.agents[0]?.id || null);
  const [note, setNote] = useState<{ text: string; error: boolean }>({ text: DEFAULT_NOTE, error: false });

  // フォーム値 (editingType/editingId の変化で同期する)
  const [agentForm, setAgentForm] = useState<AgentForm>({
    name: "",
    description: "",
    systemPrompt: "",
    skillIds: [],
    model: null,
    thinkingLevel: null,
  });
  const [skillForm, setSkillForm] = useState({ name: "", description: "", prompt: "" });

  const editingAgent = catalog.agents.find((agent) => agent.id === editingId);
  const editingSkill = catalog.skills.find((skill) => skill.id === editingId);
  const isAgent = editingType === "agent";

  const setNoteText = (text: string, error = false) => setNote({ text, error });

  // モーダル dialog として開く。背面の inert 化と Tab のフォーカス拘束、Escape での終了は showModal() の標準挙動に任せる。
  // StrictMode の二重実行でも例外にならないよう open を確認する。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!dialog.contains(document.activeElement)) {
      // 直前の cleanup でフォーカスが背面へ戻されている (StrictMode)
      dialog.focus();
    }
    return () => previousFocusRef.current?.focus();
  }, []);

  // 自分自身の state を render 中に調整し、古いフォームを DOM に commit しない (catalog 再読込時にも初期化する)。
  const [formSource, setFormSource] = useState<{ editingType: EditingType; editingId: string | null; catalog: Catalog } | null>(null);
  if (formSource?.editingType !== editingType || formSource?.editingId !== editingId || formSource?.catalog !== catalog) {
    setFormSource({ editingType, editingId, catalog });
    if (isAgent) {
      setAgentForm({
        name: editingAgent?.name || "",
        description: editingAgent?.description || "",
        systemPrompt: editingAgent?.systemPrompt || "",
        skillIds: editingAgent ? [...editingAgent.skillIds] : [],
        model: editingAgent?.model ? { ...editingAgent.model } : null,
        thinkingLevel: editingAgent?.thinkingLevel ?? null,
      });
    } else {
      setSkillForm({
        name: editingSkill?.name || "",
        description: editingSkill?.description || "",
        prompt: editingSkill?.prompt || "",
      });
    }
  }

  /** タブ切替: その一覧の先頭項目を選ぶ */
  const selectTab = (type: EditingType) => {
    if (type === editingType) return;
    setEditingType(type);
    setEditingId(
      type === "agent" ? (catalog.agents[0]?.id ?? null) : (catalog.skills[0]?.id ?? null),
    );
  };

  const selectItem = (type: EditingType, id: string) => {
    setEditingType(type);
    setEditingId(id);
  };

  const startNewAgent = () => {
    setEditingType("agent");
    setEditingId(null);
    setNoteText("新しいエージェントを作成します。");
  };

  const startNewSkill = () => {
    setEditingType("skill");
    setEditingId(null);
    setNoteText("新しいスキルを作成します。");
  };

  const saveAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = {
      name: agentForm.name,
      description: agentForm.description,
      systemPrompt: agentForm.systemPrompt,
      skillIds: agentForm.skillIds,
      // null はサーバー側で「指定解除」に正規化される
      model: agentForm.model,
      thinkingLevel: agentForm.thinkingLevel,
    };
    try {
      const result = editingId
        ? await updateAgent(editingId, payload)
        : await createAgent(payload);
      setEditingType("agent");
      setEditingId(result.agent.id);
      await refreshCatalog();
      setNoteText("エージェントを保存しました。適用するには新しい会話を開始してください。");
    } catch (error) {
      setNoteText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const saveSkill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = { name: skillForm.name, description: skillForm.description, prompt: skillForm.prompt };
    try {
      const result = editingId ? await updateSkill(editingId, payload) : await createSkill(payload);
      setEditingType("skill");
      setEditingId(result.skill.id);
      await refreshCatalog();
      setNoteText("スキルを保存しました。エージェントに割り当てて使えます。");
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

  const removeCurrentSkill = async () => {
    if (!editingId) return;
    if (!window.confirm("このスキルを削除しますか？")) return;
    try {
      await deleteSkill(editingId);
      setEditingId(null);
      await refreshCatalog();
      setEditingType("skill");
      setNoteText("スキルを削除しました。割り当てからも外れました。");
    } catch (error) {
      setNoteText(error instanceof Error ? error.message : String(error), true);
    }
  };

  const exportDefinitions = () => {
    const body = JSON.stringify({ agents: catalog.agents, skills: catalog.skills }, null, 2);
    const blob = new Blob([body], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `agent-definitions-${date}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNoteText("エージェントとスキルを書き出しました。");
  };

  const importDefinitions = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as { agents?: unknown }).agents) ||
        !Array.isArray((parsed as { skills?: unknown }).skills)
      ) {
        throw new Error("エージェントとスキルの配列を含むJSONを選択してください");
      }
      if (!window.confirm("現在のエージェントとスキルを読み込んだ定義で置き換えますか？")) return;

      const next = await replaceCatalog(parsed as { agents: unknown[]; skills: unknown[] });
      const validAgentId = next.agents.some((agent) => agent.id === agentId) ? agentId : next.agents[0]?.id || "";
      setEditingType("agent");
      setEditingId(validAgentId || null);
      await refreshCatalog();
      setNoteText("読み込みました。適用するには新しい会話を開始してください。既存の会話は変更されません。");
    } catch (error) {
      setNoteText(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const toggleSkill = (skillId: string, checked: boolean) => {
    setAgentForm((prev) => ({
      ...prev,
      skillIds: checked ? [...prev.skillIds, skillId] : prev.skillIds.filter((id) => id !== skillId),
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

  const managerItemClass = (active: boolean) =>
    [
      // 長い説明文が一覧のグリッド幅を押し広げないようにする。
      "flex min-w-0 w-full cursor-pointer flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
      active ? "border-accent/35 bg-accent-wash" : "border-transparent bg-soft hover:bg-hover",
    ].join(" ");

  const tabClass = (active: boolean) =>
    [
      "min-h-10 cursor-pointer rounded-t-lg border-b-2 px-3.5 text-xs font-semibold transition-colors",
      active ? "border-focus text-accent-text" : "border-transparent text-ink-soft hover:text-ink",
    ].join(" ");

  return (
    // フルスクリーンのモーダル dialog。背面へのフォーカスとポインタ操作は showModal() が遮断する。
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-modal="true"
      aria-label="エージェントとスキルを管理"
      tabIndex={-1}
      className="m-0 grid h-dvh w-screen max-h-none max-w-none grid-rows-[auto_minmax(0,1fr)_auto] rounded-none border-0 bg-base p-0 text-ink"
    >
      {/* ヘッダ */}
      <header
        className={[
          "flex flex-wrap items-start justify-between border-b border-line",
          compact ? "grid grid-cols-[minmax(0,1fr)] gap-2.5 px-4 pb-3 pt-3.5" : "gap-3 px-5 pb-3.5 pt-4",
        ].join(" ")}
      >
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">CONFIGURATION</div>
          <h2 className="text-lg font-semibold text-ink-strong">エージェントとスキル</h2>
        </div>
        <div className={["flex items-center gap-2", compact ? "w-full justify-between" : ""].join(" ")}>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="min-h-9 rounded-lg border border-line px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
            >
              インポート
            </button>
            <button
              type="button"
              onClick={exportDefinitions}
              className="min-h-9 rounded-lg border border-line px-3 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
            >
              エクスポート
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importDefinitions(file);
              }}
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-9 rounded-lg border border-line px-3 text-xs text-ink-soft transition-colors hover:border-danger/60 hover:text-danger"
          >
            閉じる
          </button>
        </div>
      </header>

      {/* 本文: 左にタブ + 一覧、右にエディタ */}
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] wide:grid-cols-[248px_minmax(0,1fr)] wide:grid-rows-[minmax(0,1fr)]">
        <aside className="flex min-h-0 min-w-0 flex-col wide:border-r wide:border-line">
          <div role="tablist" aria-label="管理対象の種別" className="flex gap-1 border-b border-line px-3">
            <button
              type="button"
              role="tab"
              aria-selected={isAgent}
              onClick={() => selectTab("agent")}
              className={tabClass(isAgent)}
            >
              エージェント
              <span className="ml-1.5 text-[10px] font-normal text-ink-faint">{catalog.agents.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isAgent}
              onClick={() => selectTab("skill")}
              className={tabClass(!isAgent)}
            >
              スキル
              <span className="ml-1.5 text-[10px] font-normal text-ink-faint">{catalog.skills.length}</span>
            </button>
          </div>

          {/* 一覧: 画面の縦幅を使うため、件数が増えてもスクロールで耐える */}
          <div className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 max-h-[30vh] wide:max-h-none">
            {isAgent ? (
              <>
                <button
                  type="button"
                  onClick={startNewAgent}
                  className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
                >
                  ＋ 新しいエージェント
                </button>
                <div className="grid min-w-0 gap-1">
                  {catalog.agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => selectItem("agent", agent.id)}
                      className={managerItemClass(isAgent && editingId === agent.id)}
                    >
                      <strong className="min-w-0 truncate text-xs text-ink">{agent.name}</strong>
                      <span className="min-w-0 truncate text-[10px] text-ink-muted">{agent.description || "説明なし"}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startNewSkill}
                  className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-[11px] text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
                >
                  ＋ 新しいスキル
                </button>
                <div className="grid min-w-0 gap-1">
                  {catalog.skills.map((skill) => (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => selectItem("skill", skill.id)}
                      className={managerItemClass(!isAgent && editingId === skill.id)}
                    >
                      <strong className="min-w-0 truncate text-xs text-ink">{skill.name}</strong>
                      <span className="min-w-0 truncate text-[10px] text-ink-muted">{skill.description || "説明なし"}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* エディタ */}
        <section className="scrollbar-thin min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4 py-4">
          {isAgent ? (
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
                  onChange={(e) => setAgentForm((p) => ({ ...p, name: e.currentTarget.value }))}
                />
              </label>
              <label className="grid gap-1 text-[11px] text-ink-soft">
                説明
                <input
                  className="field text-xs"
                  maxLength={300}
                  value={agentForm.description}
                  onChange={(e) => setAgentForm((p) => ({ ...p, description: e.currentTarget.value }))}
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
                  onChange={(e) => setAgentForm((p) => ({ ...p, systemPrompt: e.currentTarget.value }))}
                />
              </label>
              <div className="grid gap-2 rounded-lg border border-line bg-soft px-2.5 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  Model / Effort
                </div>
                <div className="grid gap-2 wide:grid-cols-2">
                  <label className="grid gap-1 text-[11px] text-ink-soft">
                    Model
                    <select
                      className="field cursor-pointer text-xs"
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
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] text-ink-soft">
                    Effort
                    <select
                      className="field cursor-pointer text-xs disabled:cursor-not-allowed disabled:opacity-55"
                      aria-label="エージェントの Effort"
                      value={agentForm.thinkingLevel ?? ""}
                      onChange={(e) =>
                        setAgentForm((p) => ({
                          ...p,
                          thinkingLevel: (e.currentTarget.value || null) as ThinkingLevel | null,
                        }))
                      }
                    >
                      <option value="">
                        {defaultThinkingLevel ? `未指定（アプリ既定: ${effortLabel(defaultThinkingLevel)}）` : "未指定"}
                      </option>
                      {agentEffortChoices.map((level) => (
                        <option key={level} value={level} disabled={!agentSupportsThinking}>
                          {effortLabel(level)}
                        </option>
                      ))}
                    </select>
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
              <div className="text-[11px] text-ink-soft">割り当てるスキル</div>
              <div className="grid gap-1.5">
                {catalog.skills.length === 0 ? (
                  <div className="text-[11px] text-ink-faint">スキルがありません。「スキル」タブから作成できます。</div>
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
                    className="min-h-9 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
                  >
                    削除
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="min-h-9 flex-1 rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent transition-colors hover:brightness-110"
                >
                  保存
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={saveSkill} className="mx-auto grid max-w-2xl gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text">SKILL</div>
                <h3 className="text-sm font-semibold text-ink-strong">
                  {editingSkill ? "スキルを編集" : "新しいスキル"}
                </h3>
              </div>
              <label className="grid gap-1 text-[11px] text-ink-soft">
                名前
                <input
                  className="field text-xs"
                  required
                  maxLength={80}
                  value={skillForm.name}
                  onChange={(e) => setSkillForm((p) => ({ ...p, name: e.currentTarget.value }))}
                />
              </label>
              <label className="grid gap-1 text-[11px] text-ink-soft">
                説明
                <input
                  className="field text-xs"
                  maxLength={300}
                  value={skillForm.description}
                  onChange={(e) => setSkillForm((p) => ({ ...p, description: e.currentTarget.value }))}
                />
              </label>
              <label className="grid gap-1 text-[11px] text-ink-soft">
                指示
                <textarea
                  className="field min-h-36 text-xs leading-relaxed"
                  rows={8}
                  maxLength={8000}
                  placeholder="例: 結論を先に述べ、根拠をファイル名付きで示す"
                  value={skillForm.prompt}
                  onChange={(e) => setSkillForm((p) => ({ ...p, prompt: e.currentTarget.value }))}
                />
              </label>
              <div className="flex gap-2 pt-1">
                {editingSkill ? (
                  <button
                    type="button"
                    onClick={() => void removeCurrentSkill()}
                    className="min-h-9 rounded-lg border border-danger/50 px-3 text-xs text-danger-text transition-colors hover:bg-danger/10"
                  >
                    削除
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="min-h-9 flex-1 rounded-lg bg-accent px-4 text-xs font-semibold text-on-accent transition-colors hover:brightness-110"
                >
                  保存
                </button>
              </div>
            </form>
          )}
        </section>
      </div>

      {/* ノート行 */}
      <div
        aria-live="polite"
        className={[
          "border-t border-line px-5 py-2.5 text-[11px] break-words",
          note.error ? "text-danger-text" : "text-ink-muted",
        ].join(" ")}
      >
        {note.text}
      </div>
    </dialog>
  );
}
