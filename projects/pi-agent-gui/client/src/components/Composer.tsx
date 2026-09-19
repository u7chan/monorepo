import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { ComposerSettings } from "../hooks/useAgentDesk";
import { cn } from "../lib/cn";
import type { LayoutMode } from "../lib/layout";
import type { AgentDef, ContextUsage, MessageImage, ModelRef, ThinkingLevel } from "../types";
import { AgentField } from "./composer/AgentField";
import { ContextGauge } from "./composer/ContextGauge";
import { ModelEffortFields, ModelEffortToggle } from "./composer/ModelEffortControls";

export type ComposerProps = {
  activity: string;
  /** 実行中だけ渡す (活動行の経過時間の起点) */
  runningSince?: number;
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
  onSend: (text: string, images?: MessageImage[]) => void;
  onStop: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
  onChangeAgent: (agentId: string) => void;
};

const MAX_TEXTAREA_HEIGHT = 180;
/** compact では入力欄が画面を占めないよう低く抑える */
const COMPACT_TEXTAREA_HEIGHT = 120;
const MAX_IMAGES = 10;

type PendingImage = MessageImage & {
  id: number;
  name: string;
};

function imageMimeType(file: File): string | undefined {
  if (file.type.startsWith("image/")) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return undefined;
}

function readImage(file: File): Promise<MessageImage> {
  const mimeType = imageMimeType(file);
  if (!mimeType) return Promise.reject(new Error(`${file.name} は画像として読み込めません`));

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} の読み込みに失敗しました`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`${file.name} の読み込みに失敗しました`));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error(`${file.name} の読み込みに失敗しました`));
        return;
      }
      resolve({ data: reader.result.slice(separator + 1), mimeType });
    };
    reader.readAsDataURL(file);
  });
}

function PaperclipIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="m6.25 8.75 3.9-3.9a2.25 2.25 0 0 1 3.18 3.18l-5.2 5.2a3.5 3.5 0 0 1-4.95-4.95l5.2-5.2" />
    </svg>
  );
}

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
  runningSince,
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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const nextImageIdRef = useRef(1);
  const [value, setValue] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState("");
  const [readingImages, setReadingImages] = useState(false);
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
    if (
      (!text && images.length === 0) ||
      !runtimeReady ||
      sending ||
      readingImages ||
      settings.changing ||
      settings.sendBlockedReason
    ) {
      return;
    }
    const outgoingImages = images.map(({ data, mimeType }) => ({ data, mimeType }));
    setValue("");
    setImages([]);
    setImageError("");
    onSend(text, outgoingImages);
    inputRef.current?.focus();
  };

  const handleImagesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selected.length === 0) return;

    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      setImageError(`画像は最大${MAX_IMAGES}枚まで添付できます`);
      return;
    }
    const files = selected.slice(0, remaining);
    if (selected.length > remaining) {
      setImageError(`画像は最大${MAX_IMAGES}枚までです。先頭${remaining}枚を追加しました`);
    } else {
      setImageError("");
    }

    setReadingImages(true);
    try {
      const results = await Promise.allSettled(files.map((file) => readImage(file)));
      const loaded = results.flatMap((result, index) => {
        if (result.status !== "fulfilled") return [];
        const image: PendingImage = {
          ...result.value,
          id: nextImageIdRef.current++,
          name: files[index].name,
        };
        return [image];
      });
      setImages((current) => [...current, ...loaded].slice(0, MAX_IMAGES));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        setImageError(failed.reason instanceof Error ? failed.reason.message : "画像の読み込みに失敗しました");
      }
    } finally {
      setReadingImages(false);
    }
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
      className={cn(
        "shrink-0 cursor-pointer bg-transparent p-0 text-2xs text-warn transition-colors hover:brightness-125",
        compact ? "px-1 py-0.5" : "",
      )}
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
      className={cn(
        "w-full min-w-0",
        compact ? "px-3 pb-[max(8px,env(safe-area-inset-bottom))]" : "mx-auto max-w-220 px-6 pb-5 wide:px-8",
      )}
    >
      <ContextGauge activity={activity} runningSince={runningSince} context={context} compact={compact} />
      <form
        onSubmit={handleSubmit}
        className={cn(
          "grid rounded-xl border border-line-strong bg-panel/90 shadow-panel",
          compact ? "gap-1.5 p-2" : "gap-2 p-2.5",
        )}
      >
        <div className={cn("flex flex-wrap items-center", compact ? "gap-2" : "gap-x-3 gap-y-1.5 px-0.5")}>
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
              {rowNotice ? <span className="min-w-0 text-2xs break-words text-warn">{rowNotice}</span> : null}
            </>
          )}
        </div>
        {compact && settingsOpen ? (
          <div
            className={cn(
              "grid gap-1.5 rounded-lg border border-line bg-soft px-2 py-2",
              landscape ? "grid-cols-2" : "",
            )}
          >
            <ModelEffortFields
              settings={settings}
              compact={compact}
              onChangeModel={onChangeModel}
              onChangeThinkingLevel={onChangeThinkingLevel}
            />
            {notice ? (
              <span className={cn("min-w-0 text-2xs break-words text-warn", landscape ? "col-span-2" : "")}>
                {notice}
              </span>
            ) : null}
          </div>
        ) : null}
        {images.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-0.5">
            {images.map((image) => (
              <div key={image.id} className="relative shrink-0">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name}
                  className={cn("rounded-lg object-cover", compact ? "size-14" : "size-16")}
                />
                <button
                  type="button"
                  aria-label={`${image.name} を削除`}
                  onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                  className="absolute top-1 right-1 grid size-5 cursor-pointer place-items-center rounded-full bg-base/85 text-xs leading-none text-ink shadow-sm"
                >
                  ×
                </button>
              </div>
            ))}
            <span className="shrink-0 text-2xs text-ink-ghost">
              {images.length}/{MAX_IMAGES}
            </span>
          </div>
        ) : null}
        {imageError ? <span className="text-2xs text-warn">{imageError}</span> : null}
        <div className={cn("flex items-end", compact ? "gap-2" : "gap-2.5")}>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => void handleImagesSelected(event)}
          />
          <button
            type="button"
            aria-label="画像を追加"
            title="画像を追加"
            disabled={readingImages || images.length >= MAX_IMAGES}
            onClick={() => imageInputRef.current?.click()}
            className={cn(
              "grid shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong bg-transparent text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-45",
              compact ? "size-9" : "size-8",
            )}
          >
            <PaperclipIcon />
          </button>
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
            className={cn(
              "flex-1 resize-none bg-transparent px-0.5 leading-normal text-ink outline-none placeholder:text-ink-ghost",
              compact ? "max-h-30 min-h-9 py-1.5 text-md" : "max-h-45 min-h-6 py-1",
            )}
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
              readingImages ||
              (value.trim().length === 0 && images.length === 0)
            }
            className={cn(
              "grid shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-on-accent transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45",
              compact ? "size-9" : "size-8",
            )}
          >
            <ArrowUpIcon />
          </button>
        </div>
      </form>
      {compact ? (
        collapsedWarnings.length > 0 || stopVisible ? (
          <div className="flex items-center justify-end gap-2 px-1 pt-1.5 text-2xs text-ink-ghost">
            {collapsedWarnings.length > 0 ? (
              <span className="mr-auto min-w-0 break-words text-warn">{collapsedWarnings.join(" / ")}</span>
            ) : null}
            {stopButton}
          </div>
        ) : null
      ) : (
        <div className="flex items-start justify-between gap-2.5 px-1 pt-2 text-2xs text-ink-ghost">
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
