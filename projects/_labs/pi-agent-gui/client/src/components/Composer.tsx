import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { effortLabel, type ComposerSettings } from "../hooks/useAgentDesk";
import type { ModelRef, ThinkingLevel } from "../types";

export type ComposerProps = {
  activity: string;
  runtimeReady: boolean;
  sending: boolean;
  stopVisible: boolean;
  queueDepth: number;
  /** チャットの実効値 / 作成前の選択値と候補 */
  settings: ComposerSettings;
  onSend: (text: string) => void;
  onStop: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
};

const MAX_TEXTAREA_HEIGHT = 180;

/** 候補に無いモデルも表示できるように選択肢へ足す */
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
  onSend,
  onStop,
  onChangeModel,
  onChangeThinkingLevel,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [stopping, setStopping] = useState(false);

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

  const resize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  };

  useEffect(() => {
    resize();
  }, [value]);

  const submit = () => {
    const text = value.trim();
    // 設定変更中は送信を待たせる (サーバー側でも 409)
    if (!text || !runtimeReady || sending || settings.changing || settings.sendBlockedReason) return;
    setValue("");
    onSend(text);
    // 送信後はフォーカスを戻す (旧実装と同じ)
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

  return (
    <footer className="mx-auto w-full min-w-0 max-w-[880px] px-6 pb-5 max-nav:px-[18px] max-nav:pb-[max(14px,env(safe-area-inset-bottom))] wide:px-8">
      {activity ? (
        <div aria-live="polite" className="min-h-[21px] break-words px-1 pb-1.5 text-[11px] text-ink-muted">
          {activity}
        </div>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className="grid gap-2 rounded-[13px] border border-line-strong bg-panel/90 p-2.5 shadow-panel"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-0.5">
          <label className="flex min-w-0 items-center gap-1.5 text-[10px] text-ink-faint">
            <span className="shrink-0 uppercase tracking-wide">Model</span>
            <select
              aria-label="モデルを選択"
              className="field max-w-[240px] cursor-pointer px-1.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-55"
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
          <label className="flex min-w-0 items-center gap-1.5 text-[10px] text-ink-faint">
            <span className="shrink-0 uppercase tracking-wide">Effort</span>
            <select
              aria-label="Effort を選択"
              className="field max-w-[160px] cursor-pointer px-1.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-55"
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
          {notice ? <span className="min-w-0 break-words text-[10px] text-warn">{notice}</span> : null}
        </div>
        <div className="flex items-end gap-2.5">
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            placeholder={runtimeReady ? "メッセージを入力… (Enterで送信 / Shift+Enterで改行)" : "APIキーを設定すると送信できます"}
            className="min-h-6 max-h-[180px] flex-1 resize-none bg-transparent px-0.5 py-1 leading-normal text-ink outline-none placeholder:text-ink-ghost"
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
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-[9px] bg-accent-bright text-[18px] font-bold text-on-accent transition-all hover:-translate-y-px hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
          >
            <span>↑</span>
          </button>
        </div>
      </form>
      <div className="flex items-start justify-between gap-2.5 px-1 pt-2 text-[10px] text-ink-ghost">
        <span className="min-w-0 break-words">
          送信後もブラウザを閉じても処理は続きます
          {settings.sendBlockedReason ? (
            <span className="ml-1 text-warn">{settings.sendBlockedReason}</span>
          ) : null}
        </span>
        {stopVisible ? (
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={stopping}
            className="shrink-0 cursor-pointer bg-transparent p-0 text-[10px] text-warn transition-colors hover:brightness-125"
          >
            {queueDepth > 0 ? `停止（待機${queueDepth}件）` : "停止"}
          </button>
        ) : null}
      </div>
    </footer>
  );
}
