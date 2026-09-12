import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { effortLabel, type ComposerSettings } from "../hooks/useAgentDesk";
import type { LayoutMode } from "../lib/layout";
import type { AgentDef, ModelRef, ThinkingLevel } from "../types";
import { SelectField } from "./SelectField";
import { SlidersIcon } from "./icons";

export type ComposerProps = {
  activity: string;
  runtimeReady: boolean;
  sending: boolean;
  stopVisible: boolean;
  queueDepth: number;
  /** チャットの実効値 / 作成前の選択値と候補 */
  settings: ComposerSettings;
  /** エージェント候補と選択中の定義 (会話中いつでも切り替えられるよう入力欄の上に置く) */
  agents: AgentDef[];
  agentId: string;
  /** compact (portrait / landscape) では Model / Effort を畳んで入力を最優先にする */
  mode: LayoutMode;
  onSend: (text: string) => void;
  onStop: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
  /** 選択中のエージェントで新しい会話を始める */
  onChangeAgent: (agentId: string) => void;
};

const MAX_TEXTAREA_HEIGHT = 180;
/** compact では入力欄が画面を占めないよう低く抑える */
const COMPACT_TEXTAREA_HEIGHT = 120;

function ArrowUpIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M8 13.25V2.75" />
      <path d="M3.5 7.25 8 2.75l4.5 4.5" />
    </svg>
  );
}

/** 候補に無いモデルも表示できるよう選択肢へ足す */
function modelChoicesOf(settings: ComposerSettings): Array<{ value: string; label: string }> {
  const choices = settings.modelOptions.map((option) => ({
    value: `${option.provider}/${option.id}`,
    label: option.name ? `${option.name}（${option.provider}/${option.id}）` : `${option.provider}/${option.id}`,
  }));
  if (settings.model && !choices.some((choice) => choice.value === settings.model)) {
    choices.push({ value: settings.model, label: `${settings.model}（利用不可）` });
  }
  return choices;
}

export function Composer({
  activity,
  runtimeReady,
  sending,
  stopVisible,
  queueDepth,
  settings,
  agents,
  agentId,
  mode,
  onSend,
  onStop,
  onChangeModel,
  onChangeThinkingLevel,
  onChangeAgent,
}: ComposerProps) {
  const compact = mode !== "desktop";
  // landscape は横幅が余るので、設定を開いたときの高さを抑える
  const landscape = mode === "landscape";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [stopping, setStopping] = useState(false);
  /** Model / Effort の追加設定を開いているか (既定は畳む) */
  const [settingsOpen, setSettingsOpen] = useState(false);

  const modelChoices = useMemo(() => modelChoicesOf(settings), [settings]);
  // SDK が補正した実効値が候補に無くても表示できるようにする
  const effortChoices = useMemo(() => {
    const levels = [...settings.thinkingLevels];
    const current = settings.thinkingLevel;
    if (current && !levels.includes(current as ThinkingLevel)) levels.push(current as ThinkingLevel);
    return levels;
  }, [settings.thinkingLevels, settings.thinkingLevel]);

  const modelDisabled = settings.disabled || settings.modelOptions.length === 0;
  const effortDisabled = settings.disabled || !settings.supportsThinking || effortChoices.length === 0;
  const notice = settings.modelWarning ?? settings.effortNotice;
  const maxTextareaHeight = compact ? COMPACT_TEXTAREA_HEIGHT : MAX_TEXTAREA_HEIGHT;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxTextareaHeight)}px`;
  }, [value, maxTextareaHeight]);

  const submit = () => {
    const text = value.trim();
    // 設定変更中は送信を待たせる (サーバー側でも 409)
    if (!text || !runtimeReady || sending || settings.changing || settings.sendBlockedReason) return;
    setValue("");
    onSend(text);
    inputRef.current?.focus();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      onStop();
    } finally {
      setStopping(false);
    }
  };

  const handleModelChange = (next: string) => {
    const slash = next.indexOf("/");
    if (slash <= 0) return;
    onChangeModel({ provider: next.slice(0, slash), id: next.slice(slash + 1) });
  };

  const fieldLabelClass = [
    "flex min-w-0 items-center text-[10px] text-ink-faint",
    compact ? "gap-2" : "gap-1.5",
  ].join(" ");
  const fieldNameClass = compact ? "w-12 shrink-0 uppercase tracking-wide" : "shrink-0 uppercase tracking-wide";
  // compact の入力欄は iOS Safari の focus 時ズームを避けるため 16px 以上にする
  // (theme の色トークンが base なので Tailwind の text-base は使えない)
  // 余白と伸縮は wrapper 側に置く (select は chevron と重ならない右余白を SelectField が持つ)
  const selectClass = [
    "py-1 pl-1.5 disabled:cursor-not-allowed disabled:opacity-55",
    compact ? "text-[16px]" : "text-[11px]",
  ].join(" ");
  const selectWrapperClass = (maxWidth: string) => (compact ? "min-w-0 flex-1" : `min-w-0 ${maxWidth}`);

  const modelField = (
    <label className={fieldLabelClass}>
      <span className={fieldNameClass}>Model</span>
      <SelectField
        aria-label="モデルを選択"
        className={selectClass}
        wrapperClassName={selectWrapperClass("max-w-[240px]")}
        value={settings.model ?? ""}
        disabled={modelDisabled}
        onChange={(event) => handleModelChange(event.currentTarget.value)}
      >
        {settings.model ? null : <option value="">未選択</option>}
        {modelChoices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </SelectField>
    </label>
  );

  const effortField = (
    <label className={fieldLabelClass}>
      <span className={fieldNameClass}>Effort</span>
      <SelectField
        aria-label="Effort を選択"
        className={selectClass}
        wrapperClassName={selectWrapperClass("max-w-[160px]")}
        value={settings.thinkingLevel ?? ""}
        disabled={effortDisabled}
        onChange={(event) => onChangeThinkingLevel(event.currentTarget.value as ThinkingLevel)}
      >
        {settings.thinkingLevel ? null : <option value="">未選択</option>}
        {effortChoices.map((level) => (
          <option key={level} value={level}>
            {effortLabel(level)}
          </option>
        ))}
      </SelectField>
    </label>
  );

  // Model / Effort は追加設定。畳んでいるときはモデルが使えない警告だけを残す (Effort の注意書きは設定の中身なので出さない)
  const rowNotice = settingsOpen ? notice : settings.modelWarning;

  const agentField = (
    <label className={fieldLabelClass}>
      <span className="shrink-0">エージェント</span>
      <SelectField
        aria-label="エージェントを選択"
        className={selectClass}
        wrapperClassName={selectWrapperClass("max-w-[200px]")}
        value={agentId}
        disabled={agents.length === 0}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next !== agentId) onChangeAgent(next);
        }}
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </SelectField>
    </label>
  );

  const settingsToggle = (
    <button
      type="button"
      onClick={() => setSettingsOpen((open) => !open)}
      aria-expanded={settingsOpen}
      aria-label="モデルと Effort の設定"
      title="モデルと Effort"
      className={[
        // compact は入力欄と高さを揃えてタップ領域も広く取る
        "grid shrink-0 cursor-pointer place-items-center rounded-full border transition-colors",
        compact ? "size-9" : "size-7",
        settingsOpen
          ? "border-accent/50 bg-accent-wash text-accent-text"
          : "border-line bg-raised text-ink-faint hover:text-ink-soft",
      ].join(" ")}
    >
      <SlidersIcon />
    </button>
  );

  const stopButton = stopVisible ? (
    <button
      type="button"
      onClick={() => void handleStop()}
      disabled={stopping}
      className={[
        "shrink-0 cursor-pointer bg-transparent p-0 text-[10px] text-warn transition-colors hover:brightness-125",
        compact ? "px-1 py-0.5" : "",
      ].join(" ")}
    >
      {queueDepth > 0 ? `停止（待機${queueDepth}件）` : "停止"}
    </button>
  ) : null;

  // 畳んだ状態では、送信できない理由 (モデル不在) だけを残す
  const collapsedWarnings = [compact && !settingsOpen ? settings.modelWarning : undefined, settings.sendBlockedReason]
    .filter((text): text is string => Boolean(text));

  return (
    <footer
      className={[
        "w-full min-w-0",
        compact
          ? "px-3 pb-[max(8px,env(safe-area-inset-bottom))]"
          : "mx-auto max-w-[880px] px-6 pb-5 wide:px-8",
      ].join(" ")}
    >
      {activity ? (
        <div aria-live="polite" className="min-h-[21px] break-words px-1 pb-1.5 text-[11px] text-ink-muted">
          {activity}
        </div>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className={[
          "grid rounded-[13px] border border-line-strong bg-panel/90 shadow-panel",
          compact ? "gap-1.5 p-2" : "gap-2 p-2.5",
        ].join(" ")}
      >
        {/* エージェントは常時表示し、Model / Effort は追加設定として畳む */}
        <div className={["flex flex-wrap items-center", compact ? "gap-2" : "gap-x-3 gap-y-1.5 px-0.5"].join(" ")}>
          {agentField}
          {settingsToggle}
          {compact ? null : (
            <>
              {settingsOpen ? modelField : null}
              {settingsOpen ? effortField : null}
              {/* 警告の置き場所は compact では footnote (collapsedWarnings) に揃える */}
              {rowNotice ? <span className="min-w-0 break-words text-[10px] text-warn">{rowNotice}</span> : null}
            </>
          )}
        </div>
        {/* compact の設定は入力欄の上に開く (横幅が足りないのでエージェントの行に並べない) */}
        {compact && settingsOpen ? (
          <div className={["grid gap-1.5 rounded-lg border border-line bg-soft px-2 py-2", landscape ? "grid-cols-2" : ""].join(" ")}>
            {modelField}
            {effortField}
            {notice ? (
              <span className={["min-w-0 break-words text-[10px] text-warn", landscape ? "col-span-2" : ""].join(" ")}>
                {notice}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className={["flex items-end", compact ? "gap-2" : "gap-2.5"].join(" ")}>
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            placeholder={
              runtimeReady
                ? // compact は 1 行の入力欄を保ちたいので Enter の説明は desktop だけに出す
                  compact
                  ? "メッセージを入力…"
                  : "メッセージを入力… (Enterで送信 / Shift+Enterで改行)"
                : "APIキーを設定すると送信できます"
            }
            className={[
              "flex-1 resize-none bg-transparent px-0.5 leading-normal text-ink outline-none placeholder:text-ink-ghost",
              compact ? "min-h-9 max-h-[120px] py-1.5 text-[16px]" : "min-h-6 max-h-[180px] py-1",
            ].join(" ")}
            onChange={(event) => setValue(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="submit"
            aria-label="送信"
            disabled={
              !runtimeReady ||
              sending ||
              settings.changing ||
              Boolean(settings.sendBlockedReason) ||
              value.trim().length === 0
            }
            className={[
              "grid shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-on-accent transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45",
              compact ? "size-9" : "size-8",
            ].join(" ")}
          >
            <ArrowUpIcon />
          </button>
        </div>
      </form>
      {compact ? (
        collapsedWarnings.length > 0 || stopVisible ? (
          <div className="flex items-center justify-end gap-2 px-1 pt-1.5 text-[10px] text-ink-ghost">
            {collapsedWarnings.length > 0 ? (
              <span className="mr-auto min-w-0 break-words text-warn">{collapsedWarnings.join(" / ")}</span>
            ) : null}
            {stopButton}
          </div>
        ) : null
      ) : (
        <div className="flex items-start justify-between gap-2.5 px-1 pt-2 text-[10px] text-ink-ghost">
          <span className="min-w-0 break-words">
            送信後もブラウザを閉じても処理は続きます
            {settings.sendBlockedReason ? (
              <span className="ml-1 text-warn">{settings.sendBlockedReason}</span>
            ) : null}
          </span>
          {stopButton}
        </div>
      )}
    </footer>
  );
}
