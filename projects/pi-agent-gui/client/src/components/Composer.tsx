import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ComposerSettings } from "../hooks/useAgentDesk";
import type { LayoutMode } from "../lib/layout";
import type { AgentDef, ContextUsage, ModelRef, ThinkingLevel } from "../types";
import { AgentField } from "./composer/AgentField";
import { ContextGauge } from "./composer/ContextGauge";
import { ModelEffortFields, ModelEffortToggle } from "./composer/ModelEffortControls";

export type ComposerProps = {
  activity: string;
  runtimeReady: boolean;
  sending: boolean;
  stopVisible: boolean;
  queueDepth: number;
  context?: ContextUsage;
  settings: ComposerSettings;
  agents: AgentDef[];
  agentId: string;
  mode: LayoutMode;
  /** 非表示 (設定ページ) の間は scrollHeight を読めないので計測を止める */
  visible?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
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

export function Composer({
  activity,
  runtimeReady,
  sending,
  stopVisible,
  queueDepth,
  context,
  settings,
  agents,
  agentId,
  mode,
  visible = true,
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  const maxTextareaHeight = compact ? COMPACT_TEXTAREA_HEIGHT : MAX_TEXTAREA_HEIGHT;

  // 非表示中は scrollHeight が 0 なので測らず、visible の復帰で測り直す (下書きが最小高へ潰れるのを防ぐ)
  useEffect(() => {
    if (!visible) return;
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxTextareaHeight)}px`;
  }, [value, maxTextareaHeight, visible]);

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

  const notice = settings.modelWarning ?? settings.effortNotice;
  // Model / Effort は追加設定。Effort の注意書きは設定の中身なので、畳んでいるときはモデルが使えない警告だけを残す
  const rowNotice = settingsOpen ? notice : settings.modelWarning;
  const stopButton = stopVisible ? (
    <button
      type="button"
      onClick={onStop}
      className={[
        "shrink-0 cursor-pointer bg-transparent p-0 text-[10px] text-warn transition-colors hover:brightness-125",
        compact ? "px-1 py-0.5" : "",
      ].join(" ")}
    >
      {queueDepth > 0 ? `停止（待機${queueDepth}件）` : "停止"}
    </button>
  ) : null;
  const collapsedWarnings = [
    compact && !settingsOpen ? settings.modelWarning : undefined,
    settings.sendBlockedReason,
  ].filter((text): text is string => Boolean(text));

  return (
    <footer
      className={[
        "w-full min-w-0",
        compact ? "px-3 pb-[max(8px,env(safe-area-inset-bottom))]" : "mx-auto max-w-[880px] px-6 pb-5 wide:px-8",
      ].join(" ")}
    >
      <ContextGauge activity={activity} context={context} compact={compact} />
      <form
        onSubmit={handleSubmit}
        className={[
          "grid rounded-[13px] border border-line-strong bg-panel/90 shadow-panel",
          compact ? "gap-1.5 p-2" : "gap-2 p-2.5",
        ].join(" ")}
      >
        <div className={["flex flex-wrap items-center", compact ? "gap-2" : "gap-x-3 gap-y-1.5 px-0.5"].join(" ")}>
          <AgentField agents={agents} agentId={agentId} compact={compact} onChangeAgent={onChangeAgent} />
          <ModelEffortToggle open={settingsOpen} compact={compact} onToggle={() => setSettingsOpen((open) => !open)} />
          {compact ? null : (
            <>
              {settingsOpen ? (
                <ModelEffortFields
                  settings={settings}
                  compact={compact}
                  onChangeModel={onChangeModel}
                  onChangeThinkingLevel={onChangeThinkingLevel}
                />
              ) : null}
              {rowNotice ? <span className="min-w-0 break-words text-[10px] text-warn">{rowNotice}</span> : null}
            </>
          )}
        </div>
        {compact && settingsOpen ? (
          <div
            className={[
              "grid gap-1.5 rounded-lg border border-line bg-soft px-2 py-2",
              landscape ? "grid-cols-2" : "",
            ].join(" ")}
          >
            <ModelEffortFields
              settings={settings}
              compact={compact}
              onChangeModel={onChangeModel}
              onChangeThinkingLevel={onChangeThinkingLevel}
            />
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
                ? compact
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
            {settings.sendBlockedReason ? <span className="ml-1 text-warn">{settings.sendBlockedReason}</span> : null}
          </span>
          {stopButton}
        </div>
      )}
    </footer>
  );
}
