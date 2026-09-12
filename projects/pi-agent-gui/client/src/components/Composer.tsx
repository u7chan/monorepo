import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { effortLabel, type ComposerSettings } from "../hooks/useAgentDesk";
import type { LayoutMode } from "../lib/layout";
import type { ModelRef, ThinkingLevel } from "../types";
import { SlidersIcon } from "./icons";

export type ComposerProps = {
  activity: string;
  runtimeReady: boolean;
  sending: boolean;
  stopVisible: boolean;
  queueDepth: number;
  /** チャットの実効値 / 作成前の選択値と候補 */
  settings: ComposerSettings;
  /** compact (portrait / landscape) では Model / Effort を畳んで入力を最優先にする */
  mode: LayoutMode;
  onSend: (text: string) => void;
  onStop: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
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
  mode,
  onSend,
  onStop,
  onChangeModel,
  onChangeThinkingLevel,
}: ComposerProps) {
  const compact = mode !== "desktop";
  // landscape は横幅が余るので、設定を開いたときの高さを抑える
  const landscape = mode === "landscape";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [stopping, setStopping] = useState(false);
  /** compact で Model / Effort を開いているか */
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
  const selectClass = (maxWidth: string) =>
    [
      "field cursor-pointer px-1.5 py-1 disabled:cursor-not-allowed disabled:opacity-55",
      compact ? "min-w-0 flex-1 text-[16px]" : `${maxWidth} text-[11px]`,
    ].join(" ");

  const modelField = (
    <label className={fieldLabelClass}>
      <span className={fieldNameClass}>Model</span>
      <select
        aria-label="モデルを選択"
        className={selectClass("max-w-[240px]")}
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
      </select>
    </label>
  );

  const effortField = (
    <label className={fieldLabelClass}>
      <span className={fieldNameClass}>Effort</span>
      <select
        aria-label="Effort を選択"
        className={selectClass("max-w-[160px]")}
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
      </select>
    </label>
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
        {compact ? (
          settingsOpen ? (
            <div className={["grid gap-1.5 rounded-lg border border-line bg-soft px-2 py-2", landscape ? "grid-cols-2" : ""].join(" ")}>
              {modelField}
              {effortField}
              {notice ? (
                <span className={["min-w-0 break-words text-[10px] text-warn", landscape ? "col-span-2" : ""].join(" ")}>
                  {notice}
                </span>
              ) : null}
            </div>
          ) : null
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-0.5">
            {modelField}
            {effortField}
            {notice ? <span className="min-w-0 break-words text-[10px] text-warn">{notice}</span> : null}
          </div>
        )}
        <div className={["flex items-end", compact ? "gap-2" : "gap-2.5"].join(" ")}>
          {compact ? (
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-label="モデルと Effort の設定"
              title="モデルと Effort"
              className={[
                // compact は入力欄と高さを揃えてタップ領域も広く取る
                "grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border transition-colors",
                settingsOpen
                  ? "border-accent/50 bg-accent-wash text-accent-text"
                  : "border-line bg-raised text-ink-faint hover:text-ink-soft",
              ].join(" ")}
            >
              <SlidersIcon />
            </button>
          ) : null}
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
