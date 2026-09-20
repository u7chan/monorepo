import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
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
  onSend: (text: string, images?: MessageImage[]) => Promise<boolean>;
  onStop: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
  onChangeAgent: (agentId: string) => void;
};

const MAX_TEXTAREA_HEIGHT = 180;
/** compact では入力欄が画面を占めないよう低く抑える */
const COMPACT_TEXTAREA_HEIGHT = 120;
const MAX_IMAGES = 10;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_IMAGE_MB = MAX_TOTAL_IMAGE_BYTES / (1024 * 1024);

type PendingImage = MessageImage & {
  id: number;
  name: string;
  bytes: number;
};

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

async function detectImageMimeType(file: File): Promise<MessageImage["mimeType"] | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";

  return undefined;
}

function isHeicLike(file: File): boolean {
  const mimeType = file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase();
  return (
    mimeType === "image/heic" ||
    mimeType === "image/heif" ||
    extension === "heic" ||
    extension === "heif" ||
    extension === "heics" ||
    extension === "heifs"
  );
}

function readImage(blob: Blob, name: string, mimeType: MessageImage["mimeType"]): Promise<MessageImage & { bytes: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${name} の読み込みに失敗しました`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`${name} の読み込みに失敗しました`));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error(`${name} の読み込みに失敗しました`));
        return;
      }
      resolve({ data: reader.result.slice(separator + 1), mimeType, bytes: blob.size });
    };
    reader.readAsDataURL(blob);
  });
}

function imageElementFromObjectUrl(url: string, name: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`${name} の画像デコードに失敗しました`));
    image.src = url;
  });
}

function canvasJpeg(canvas: HTMLCanvasElement, name: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`${name} のJPEG変換に失敗しました`));
      },
      "image/jpeg",
      0.92,
    );
  });
}

/**
 * iOS の写真選択では File.type が image/jpeg でも実体が HEIC 系になるケースがある。
 * MIME を信用せず先頭バイトを検査し、Pi が直接扱えない形式はブラウザでデコードして JPEG へ正規化する。
 */
async function prepareImage(file: File): Promise<MessageImage & { bytes: number }> {
  const detected = await detectImageMimeType(file);
  if (detected) return readImage(file, file.name, detected);

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await imageElementFromObjectUrl(objectUrl, file.name);
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      throw new Error(`${file.name} の画像サイズを取得できませんでした`);
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`${file.name} の画像変換に失敗しました`);
    context.drawImage(image, 0, 0);

    const jpeg = await canvasJpeg(canvas, file.name);
    return readImage(jpeg, file.name, "image/jpeg");
  } catch (error) {
    if (isHeicLike(file)) {
      throw new Error(`${file.name} のHEIC/HEIF変換に失敗しました。JPEGまたはPNGとして書き出して再度選択してください`);
    }
    throw error instanceof Error ? error : new Error(`${file.name} は対応していない画像形式です`);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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

  const submit = async () => {
    const text = value.trim();
    // 設定変更中は送信を待たせる (サーバー側でも 409)
    if (
      (!text && images.length === 0) ||
      !runtimeReady ||
      sending ||
      readingImages ||
      settings.changing ||
      settings.sendBlockedReason ||
      (images.length > 0 && !settings.supportsImageInput)
    ) {
      return;
    }
    const outgoingImages = images.map(({ data, mimeType }) => ({ data, mimeType }));
    const sent = await onSend(text, outgoingImages);
    if (!sent) return;
    setValue("");
    setImages([]);
    setImageError("");
    inputRef.current?.focus();
  };

  const handleImagesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selected.length === 0) return;
    if (!settings.supportsImageInput) {
      setImageError("選択中のモデルは画像入力に対応していません");
      return;
    }

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
      const loaded: PendingImage[] = [];
      let totalBytes = images.reduce((sum, image) => sum + image.bytes, 0);
      let errorMessage =
        selected.length > remaining ? `画像は最大${MAX_IMAGES}枚までです。先頭${remaining}枚を確認します` : "";

      for (const file of files) {
        if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
          errorMessage = `画像の合計は${MAX_TOTAL_IMAGE_MB} MiBまでです`;
          break;
        }
        try {
          const image = await prepareImage(file);
          if (totalBytes + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
            errorMessage = `画像の合計は${MAX_TOTAL_IMAGE_MB} MiBまでです`;
            break;
          }
          loaded.push({
            ...image,
            id: nextImageIdRef.current++,
            name: file.name,
          });
          totalBytes += image.bytes;
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : "画像の読み込みに失敗しました";
        }
      }

      setImages((current) => [...current, ...loaded].slice(0, MAX_IMAGES));
      setImageError(errorMessage);
    } finally {
      setReadingImages(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
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
        {imageError || !settings.supportsImageInput ? (
          <span className="text-2xs text-warn">
            {imageError || "選択中のモデルは画像入力に対応していません"}
          </span>
        ) : null}
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
            disabled={readingImages || images.length >= MAX_IMAGES || !settings.supportsImageInput}
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
              (images.length > 0 && !settings.supportsImageInput) ||
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
