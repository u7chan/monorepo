import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export type ComposerProps = {
  activity: string;
  sending: boolean;
  stopVisible: boolean;
  queueDepth: number;
  onSend: (text: string) => void;
  onStop: () => void;
};

const MAX_TEXTAREA_HEIGHT = 180;

export function Composer({ activity, sending, stopVisible, queueDepth, onSend, onStop }: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [stopping, setStopping] = useState(false);

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
    if (!text || sending) return;
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

  return (
    <footer className="mx-auto w-full min-w-0 max-w-[880px] px-6 pb-5 max-nav:px-[18px] max-nav:pb-[max(14px,env(safe-area-inset-bottom))] wide:px-8">
      {activity ? (
        <div aria-live="polite" className="min-h-[21px] break-words px-1 pb-1.5 text-[11px] text-ink-muted">
          {activity}
        </div>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2.5 rounded-[13px] border border-line-strong bg-panel/90 p-2.5 shadow-panel"
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          placeholder="メッセージを入力… (Enterで送信 / Shift+Enterで改行)"
          className="min-h-6 max-h-[180px] flex-1 resize-none bg-transparent px-0.5 py-1 leading-normal text-ink outline-none placeholder:text-ink-ghost"
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          aria-label="送信"
          disabled={sending || value.trim().length === 0}
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-[9px] bg-accent-bright text-[18px] font-bold text-on-accent transition-all hover:-translate-y-px hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
        >
          <span>↑</span>
        </button>
      </form>
      <div className="flex items-start justify-between gap-2.5 px-1 pt-2 text-[10px] text-ink-ghost">
        <span className="min-w-0 break-words">送信後もブラウザを閉じても処理は続きます</span>
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
