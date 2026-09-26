import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import type { Attachment, ComposerSettings } from "../hooks/useU7Agent";
import type { SessionSkillsState } from "../hooks/useSessionSkills";
import { cn } from "../lib/cn";
import { shouldSubmitOnEnter } from "../lib/composerKeys";
import { composerDropKind, FILE_MENTION_MIME, insertFileMention, type ComposerDropKind } from "../lib/fileMention";
import type { LayoutMode } from "../lib/layout";
import { skillCommandText } from "../lib/sessionSkills";
import type { AgentDef, ContextUsage, ModelRef, ThinkingLevel } from "../types";
import { AgentField } from "./composer/AgentField";
import { AttachmentChips } from "./composer/AttachmentChips";
import { ComposerStatus } from "./composer/ComposerStatus";
import { ModelEffortFields, ModelEffortToggle } from "./composer/ModelEffortControls";
import { SkillPanel, SkillToggle } from "./composer/SkillField";

export type ComposerProps = {
  activity: string;
  /** 実行中 / 圧縮中だけ渡す (活動行の経過時間の起点) */
  runningSince?: number;
  runtimeReady: boolean;
  sending: boolean;
  stopVisible: boolean;
  queueDepth: number;
  context?: ContextUsage;
  settings: ComposerSettings;
  /** 手動圧縮。セッションがあるときだけ渡す (未作成チャットでは導線を出さない) */
  onCompact?: () => void;
  agents: AgentDef[];
  agentId: string;
  mode: LayoutMode;
  /** 選択中 / 送信待ちの添付。アップロード中・失敗がある間は送信できない */
  attachments: Attachment[];
  /** ワークスペース root の絶対パス (health.cwd)。画像チップの URL を組むのに使う */
  rootCwd: string;
  /** セッションのスキル一覧 (`/skill:` の入力補助)。新規チャットは作成前の選択で解決したプレビュー */
  skills: SessionSkillsState;
  onReloadSkills: () => void;
  /** 非表示 (設定ページ) の間は scrollHeight を読めないので計測を止める */
  visible?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
  onChangeAgent: (agentId: string) => void;
};

const MAX_TEXTAREA_HEIGHT = 180;
/** compact では入力欄が画面を占めないよう低く抑える */
const COMPACT_TEXTAREA_HEIGHT = 120;

/**
 * ドロップ座標に対応する入力欄の文字位置。`caretRangeFromPoint` は textarea で正しい位置を返さない
 * ブラウザーがあるため `caretPositionFromPoint` だけを使い、取れなければ現在の選択位置へ倒す。
 */
function caretOffsetAt(textarea: HTMLTextAreaElement, x: number, y: number): number | null {
  const position = document.caretPositionFromPoint?.(x, y) ?? null;
  if (position === null) return null;
  if (position.offsetNode !== textarea && !textarea.contains(position.offsetNode)) return null;
  return Math.min(Math.max(position.offset, 0), textarea.value.length);
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

function ClipIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M9.9 4.3 5.2 9a2.1 2.1 0 0 0 3 3l4.4-4.4a3.4 3.4 0 0 0-4.8-4.8L3.4 7.2a4.7 4.7 0 0 0 0 6.7" />
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
  attachments,
  rootCwd,
  skills,
  visible = true,
  onSend,
  onStop,
  onAttachFiles,
  onRemoveAttachment,
  onChangeModel,
  onChangeThinkingLevel,
  onChangeAgent,
  onCompact,
  onReloadSkills,
}: ComposerProps) {
  const compact = mode !== "desktop";
  // landscape は横幅が余るので、設定を開いたときの高さを抑える
  const landscape = mode === "landscape";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [dropKind, setDropKind] = useState<ComposerDropKind | null>(null);
  // 直前の dragover の座標。drop で参照の挿入位置を決める (drop の座標は実装によっては 0 になる)
  const dropPointRef = useRef<{ x: number; y: number } | null>(null);

  const attachmentsBusy = attachments.some((item) => item.status !== "done");
  const hasAttachment = attachments.some((item) => item.status === "done");

  const maxTextareaHeight = compact ? COMPACT_TEXTAREA_HEIGHT : MAX_TEXTAREA_HEIGHT;

  // 非表示中は scrollHeight が 0 なので測らず、visible の復帰で測り直す (下書きが最小高へ潰れるのを防ぐ)
  useEffect(() => {
    if (!visible) return;
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxTextareaHeight)}px`;
  }, [value, maxTextareaHeight, visible]);

  // 送信経路は入力欄に限らない (ChatArea の suggestion も同じ送信)。畳む条件の根拠は docs/ui-layout.md
  useEffect(() => {
    if (compact && sending) setSettingsOpen(false);
  }, [compact, sending]);

  const submit = () => {
    const text = value.trim();
    // 設定変更中は送信を待たせる (サーバー側でも 409)。添付だけの送信は許可する
    if (attachmentsBusy) return;
    if ((!text && !hasAttachment) || !runtimeReady || sending || settings.changing || settings.sendBlockedReason)
      return;
    setValue("");
    onSend(text);
    inputRef.current?.focus();
  };

  const pickFiles = (files: File[]) => {
    if (files.length > 0) onAttachFiles(files);
  };

  /** 一覧の選択はコマンドの挿入だけ。本文の展開は送信時に BFF が行う (docs/api-sessions.md) */
  const insertSkillCommand = (name: string) => {
    const el = inputRef.current;
    const text = skillCommandText(name);
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    setValue(`${value.slice(0, start)}${text}${value.slice(end)}`);
    setSkillsOpen(false);
    // 挿入した後ろへカーソルを戻す (引数を続けて書けるようにする)
    requestAnimationFrame(() => {
      const target = inputRef.current;
      if (!target) return;
      target.focus();
      const position = start + text.length;
      target.setSelectionRange(position, position);
    });
  };

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    const kind = composerDropKind(event.dataTransfer.types);
    if (kind === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dropPointRef.current = { x: event.clientX, y: event.clientY };
    setDropKind(kind);
  };

  /** ツリーの行から落とした参照を本文へ挿す。位置はドロップ位置、取れなければ現在の選択 */
  const insertMention = (path: string) => {
    const el = inputRef.current;
    const point = dropPointRef.current;
    dropPointRef.current = null;
    const offset = el && point ? caretOffsetAt(el, point.x, point.y) : null;
    const start = offset ?? el?.selectionStart ?? value.length;
    const end = offset ?? el?.selectionEnd ?? value.length;
    const insertion = insertFileMention(value, path, start, end);
    setValue(insertion.value);
    // 挿入した後ろへカーソルを戻す (続けて本文を書けるようにする)
    requestAnimationFrame(() => {
      const target = inputRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    setDropKind(null);
    const kind = composerDropKind(event.dataTransfer.types);
    if (kind === "mention") {
      event.preventDefault();
      // 空は自前のドラッグでない (他アプリの同名の型)。何もしない
      const path = event.dataTransfer.getData(FILE_MENTION_MIME);
      if (path !== "") insertMention(path);
      return;
    }
    if (kind !== "files" || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    pickFiles([...event.dataTransfer.files]);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { isComposing, keyCode } = event.nativeEvent;
    const state = { key: event.key, shiftKey: event.shiftKey, isComposing, keyCode };
    if (!shouldSubmitOnEnter(state, mode)) return;
    event.preventDefault();
    submit();
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
      <ComposerStatus
        activity={activity}
        runningSince={runningSince}
        context={context}
        model={settings.model}
        modelLabel={settings.modelLabel}
        modelUnavailable={Boolean(settings.modelWarning)}
        onCompact={onCompact}
        compactDisabled={settings.compactDisabled}
        compactDisabledReason={settings.compactDisabledReason}
      />
      <form
        onSubmit={handleSubmit}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropKind(null)}
        onDrop={handleDrop}
        className={cn(
          "grid rounded-xl border bg-panel/90 shadow-panel",
          dropKind !== null ? "border-accent" : "border-line-strong",
          compact ? "gap-1.5 p-2" : "gap-2 p-2.5",
        )}
      >
        <div className={cn("flex flex-wrap items-center", compact ? "gap-2" : "gap-x-3 gap-y-1.5 px-0.5")}>
          <AgentField agents={agents} agentId={agentId} compact={compact} onChangeAgent={onChangeAgent} />
          <ModelEffortToggle open={settingsOpen} compact={compact} onToggle={() => setSettingsOpen((open) => !open)} />
          <SkillToggle
            open={skillsOpen}
            compact={compact}
            enabled={skills.status !== "unavailable"}
            onToggle={() => setSkillsOpen((open) => !open)}
          />
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
        {skillsOpen ? (
          <SkillPanel
            state={skills}
            rootCwd={rootCwd}
            compact={compact}
            landscape={landscape}
            onSelect={insertSkillCommand}
            onReload={onReloadSkills}
          />
        ) : null}
        <AttachmentChips attachments={attachments} rootCwd={rootCwd} compact={compact} onRemove={onRemoveAttachment} />
        <div className={cn("flex items-end", compact ? "gap-2" : "gap-2.5")}>
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
            enterKeyHint={compact ? "enter" : "send"}
            onChange={(event) => setValue(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              // 同じファイルを選び直せるよう、選択を毎回リセットする
              event.currentTarget.value = "";
              pickFiles(files);
            }}
          />
          <button
            type="button"
            aria-label="ファイルを添付"
            title="ファイルを添付（最大10件・100 MiBまで）"
            onClick={() => fileRef.current?.click()}
            className={cn(
              "grid shrink-0 cursor-pointer place-items-center rounded-full border border-line text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text",
              compact ? "size-9" : "size-8",
            )}
          >
            <ClipIcon />
          </button>
          <button
            type="submit"
            aria-label="送信"
            disabled={
              !runtimeReady ||
              sending ||
              attachmentsBusy ||
              settings.changing ||
              Boolean(settings.sendBlockedReason) ||
              (value.trim().length === 0 && !hasAttachment)
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
