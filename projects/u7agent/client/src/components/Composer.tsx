import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useComposerExpansion } from "../hooks/useComposerExpansion";
import { useComposerVoiceDraft } from "../hooks/useComposerVoiceDraft";
import { useStopPromotionHold } from "../hooks/useStopPromotionHold";
import type { Attachment } from "../lib/attachments";
import type { ComposerSettings } from "../lib/composerSettings";
import type { SessionSkillsState } from "../hooks/useSessionSkills";
import { pastedImageFiles } from "../lib/clipboardImages";
import { cn } from "../lib/cn";
import { composerAction, composerPrimaryStop, composerSecondaryStop } from "../lib/composerAction";
import { composerFocusAfterSend, hasCoarsePointer } from "../lib/composerFocus";
import { shouldSubmitOnEnter } from "../lib/composerKeys";
import { submitComposer } from "../lib/composerSubmit";
import { composerDropKind, FILE_MENTION_MIME, insertFileMention, type ComposerDropKind } from "../lib/fileMention";
import type { LayoutMode } from "../lib/layout";
import type { QueuedSend } from "../lib/queueWait";
import { runRetryBlockedReason, type RunErrorInfo } from "../lib/runRetry";
import { skillCommandText } from "../lib/sessionSkills";
import { shouldClearSuggestionOnBackspace } from "../lib/suggestion";
import type { AgentDef, AgentSuggestion, ContextUsage, ModelRef, RunStatus, ThinkingLevel, ToolCall } from "../types";
import type { VoiceInputComposerPhase } from "../lib/voiceInput/composer";
import { AgentField } from "./composer/AgentField";
import { AttachmentChips } from "./composer/AttachmentChips";
import { ComposerStatus } from "./composer/ComposerStatus";
import { ModelEffortPicker } from "./composer/ModelEffortControls";
import { QueuedSends } from "./composer/QueuedSends";
import { SkillPicker } from "./composer/SkillPicker";
import { SuggestionChip } from "./composer/SuggestionChip";
import {
  VoiceInputCancelButton,
  VoiceInputFinalizingButton,
  VoiceInputStartButton,
  VoiceInputStopButton,
} from "./composer/VoiceInputControls";
import { useConfirm } from "./ConfirmProvider";
import { ArrowUpIcon, CollapseIcon, ExpandIcon, StopIcon } from "./icons";

export type ComposerProps = {
  activity: string;
  /** 活動表示の由来 (SSE `status` の state)。thinking のときだけ活動ラベルに光を流す */
  activityState?: string;
  /** 実行中の thinking 末尾 (live 専用)。状態行の下の固定領域に出す */
  thinkingText?: string;
  /** 実行中 / 圧縮中だけ渡す (活動行の経過時間の起点) */
  runningSince?: number;
  /** 回答待ち (ask_user の実行区間) を経過時間から除く入力。run が実行中のときだけ使う */
  runTools?: Record<string, ToolCall>;
  runtimeReady: boolean;
  sending: boolean;
  stopVisible: boolean;
  /** サーバーの待機キュー件数。停止が待機中の送信も破棄するかを示す根拠 */
  queueDepth: number;
  /** 待機中の送信 (実行順)。コンポーザー直上のブロックに出し、transcript には出さない */
  queuedSends?: QueuedSend[];
  /** 待機中の 1 件の取り消し。応答まで押した行を無効化する */
  onCancelQueued?: (runId: string) => Promise<void>;
  context?: ContextUsage;
  settings: ComposerSettings;
  /** 手動圧縮。セッションがあるときだけ渡す (未作成チャットでは導線を出さない) */
  onCompact?: () => void;
  /** ランがエラーで終わったか (再実行カードの表示条件) */
  runStatus?: RunStatus;
  /** 最後に失敗したランの分類コードと、BFF が合成した文言 */
  runError?: RunErrorInfo;
  /** 利用者の操作の結果 (待機の取り消しに失敗した理由など)。状態行の下の 1 行に出す */
  notice?: string;
  /** 失敗カードの再実行。固定文言を通常の送信経路で送る */
  onRetry?: () => void;
  agents: AgentDef[];
  agentId: string;
  /** セッションを開いているときのエージェント表示 (作成時のスナップショット)。渡すと選べるプルダウンにしない */
  sessionAgent?: { name: string; icon?: string };
  mode: LayoutMode;
  /** 選択中 / 送信待ちの添付。アップロード中・失敗がある間は送信できない */
  attachments: Attachment[];
  /** 選択中の定型プロンプト。押すと載り、送信本文へ織り込む (解除は Composer が持つ) */
  suggestion: AgentSuggestion | null;
  /** ワークスペース root の絶対パス (health.cwd)。画像チップの URL を組むのに使う */
  rootCwd: string;
  /** セッションのスキル一覧 (`/skill:` の入力補助)。新規チャットは作成前の選択で解決したプレビュー */
  skills: SessionSkillsState;
  /** スキルの取り直し。ポップアップを開いたときと、状態行の「再取得」で呼ぶ */
  onReloadSkills: () => void;
  /** 非表示 (設定ページ) の間は scrollHeight を読めないので計測を止める */
  visible?: boolean;
  /** 入力欄のマイクを出すか。判定 (キー / secure context) は App が起動時に取る */
  voiceInputAvailable?: boolean;
  /** 確認ダイアログに出す固定モデル名。マイクを出すときだけ使う */
  voiceInputModel?: string;
  /** 会話の切替キー。変わったら録音を中断し、確定待ちの本文を次の会話へ持ち越さない */
  voiceInputScope?: string;
  /** 音声の操作中の phase。再実行 / 未送信の再送を App が止める根拠 */
  onVoiceInputPhaseChange?: (phase: VoiceInputComposerPhase) => void;
  /** `titleSource` は定型プロンプトを結合する前の本文 (一覧タイトルの元) */
  onSend: (text: string, titleSource?: string) => void;
  onStop: () => void;
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onClearSuggestion: () => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
  onChangeAgent: (agentId: string) => void;
};

const MAX_TEXTAREA_HEIGHT = 180;
/** singleColumn では入力欄が画面を占めないよう低く抑える */
const SINGLE_COLUMN_TEXTAREA_HEIGHT = 120;

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
  activityState,
  thinkingText,
  runningSince,
  runTools,
  runtimeReady,
  sending,
  stopVisible,
  queueDepth,
  context,
  settings,
  agents,
  agentId,
  sessionAgent,
  mode,
  attachments,
  suggestion,
  rootCwd,
  skills,
  visible = true,
  voiceInputAvailable = false,
  voiceInputModel = "",
  voiceInputScope,
  onVoiceInputPhaseChange,
  onSend,
  onStop,
  onAttachFiles,
  onRemoveAttachment,
  onClearSuggestion,
  onChangeModel,
  onChangeThinkingLevel,
  onChangeAgent,
  onCompact,
  onRetry,
  runStatus,
  runError,
  notice,
  onReloadSkills,
  queuedSends,
  onCancelQueued,
}: ComposerProps) {
  const singleColumn = mode !== "desktop";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [dropKind, setDropKind] = useState<ComposerDropKind | null>(null);
  const expansion = useComposerExpansion({ inputRef, sending, visible, mode });
  const { expanded, expandedUi, dialogRef } = expansion;
  const sendHold = useStopPromotionHold();
  // 直前の dragover の座標。drop で参照の挿入位置を決める (drop の座標は実装によっては 0 になる)
  const dropPointRef = useRef<{ x: number; y: number } | null>(null);
  // 確認ダイアログ (初回の録音で 1 度だけ出す)
  const confirm = useConfirm();
  // 本文の写し。音声のコールバックは再描画をまたいで届くので、state の遅れを挟まずに前の本文と比べる
  const valueRef = useRef(value);
  /** 本文の書き換えは必ずここを通す (valueRef を同じ描画で最新にする) */
  const applyValue = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
  }, []);
  const readBody = useCallback(() => valueRef.current, []);
  const voice = useComposerVoiceDraft({
    inputRef,
    readBody,
    replaceBody: applyValue,
    confirm,
    model: voiceInputModel,
    scope: voiceInputScope,
    visible,
    ...(onVoiceInputPhaseChange === undefined ? {} : { onPhaseChange: onVoiceInputPhaseChange }),
  });

  const attachmentsBusy = attachments.some((item) => item.status !== "done");
  const hasAttachment = attachments.some((item) => item.status === "done");

  const maxTextareaHeight = singleColumn ? SINGLE_COLUMN_TEXTAREA_HEIGHT : MAX_TEXTAREA_HEIGHT;

  // 選んだチップを押した後そのまま続きを書けるよう、本文へフォーカスを移す (選択を外したときは動かさない)
  useEffect(() => {
    if (!suggestion) return;
    inputRef.current?.focus();
  }, [suggestion]);

  // チップを外しても続きを書けるよう、× の後は本文へフォーカスを戻す
  const clearSuggestion = () => {
    onClearSuggestion();
    inputRef.current?.focus();
  };

  // 非表示中は scrollHeight が 0 なので測らず、visible の復帰で測り直す (下書きが最小高へ潰れるのを防ぐ)
  useEffect(() => {
    if (!visible) return;
    const el = inputRef.current;
    if (!el) return;
    // 拡大中は面の寸法が入力欄の高さを決める (inline の height は stretch に勝つ)
    if (expandedUi) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxTextareaHeight)}px`;
  }, [value, maxTextareaHeight, visible, expandedUi]);

  // 送信経路は入力欄に限らない (再実行カードも同じ送信)。畳む条件の根拠は docs/ui-layout.md
  useEffect(() => {
    if (sending) setSettingsOpen(false);
  }, [sending]);

  // 送信の成立でスキルピッカーも畳む (singleColumn で入力欄の上を覆い、生成中は操作しない)。畳む合図は
  // Model / Effort と同じ `sending` に寄せる (desktop も開いたままだと応答に被る)
  useEffect(() => {
    if (sending) setSkillsOpen(false);
  }, [sending]);

  // 開いたときに取り直す。一覧はファイルスキルの走査結果なので、開き直しで拾えるようにする
  // (取り直しで一覧を消すかの判断は useSessionSkills 側にある)
  const handleSkillsOpenChange = useCallback(
    (open: boolean) => {
      setSkillsOpen(open);
      if (open) onReloadSkills();
    },
    [onReloadSkills],
  );

  const submit = () => {
    // 音声の操作中・終了直後の保留中は入口で止める（Enter / submit / 送信ボタンが同じ経路へ合流する）
    const sent = submitComposer(
      {
        value,
        suggestionPrompt: suggestion?.prompt ?? "",
        hasAttachment,
        runtimeReady,
        sending,
        settingsChanging: settings.changing,
        ...(settings.sendBlockedReason === undefined ? {} : { sendBlockedReason: settings.sendBlockedReason }),
        attachmentsBusy,
        voicePhase: voice.phase,
        voiceHold: voice.hold,
      },
      {
        clearDraft: () => {
          applyValue("");
          voice.clearNotice();
        },
        holdStopPromotion: sendHold.hold,
        clearSuggestion: onClearSuggestion,
        send: onSend,
      },
    );
    if (!sent) return;
    // 送信後のフォーカスはポインタで決める (docs/ui-layout.md)
    if (composerFocusAfterSend(hasCoarsePointer()) === "focus") inputRef.current?.focus();
    else inputRef.current?.blur();
  };

  const pickFiles = (files: File[]) => {
    if (files.length > 0) onAttachFiles(files);
  };

  /**
   * 貼り付けた画像を添付へ回す。画像と一緒に載る `text/html` などを本文へ混ぜないよう、
   * 添付するときだけ既定動作を止める（テキストだけの貼り付けはいじらない）。
   */
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const images = pastedImageFiles(event.clipboardData, new Date());
    if (images.length === 0) return;
    event.preventDefault();
    pickFiles(images);
  };

  /** 一覧の選択はコマンドの挿入だけ。本文の展開は送信時に BFF が行う (docs/api-session-turns.md) */
  const insertSkillCommand = (name: string) => {
    const el = inputRef.current;
    const text = skillCommandText(name);
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    applyValue(`${value.slice(0, start)}${text}${value.slice(end)}`);
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

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
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
    applyValue(insertion.value);
    // 挿入した後ろへカーソルを戻す (続けて本文を書けるようにする)
    requestAnimationFrame(() => {
      const target = inputRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(insertion.caret, insertion.caret);
    });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
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
    const { selectionStart, selectionEnd } = event.currentTarget;
    if (
      suggestion &&
      shouldClearSuggestionOnBackspace({ key: event.key, isComposing, keyCode, selectionStart, selectionEnd })
    ) {
      event.preventDefault();
      clearSuggestion();
      return;
    }
    const state = { key: event.key, shiftKey: event.shiftKey, isComposing, keyCode };
    if (!shouldSubmitOnEnter(state, mode)) return;
    event.preventDefault();
    submit();
  };

  // 再実行の押せない理由は送信経路と同じガードから導く (実際に遮っているものだけを出す)
  const retryBlockedReason = runRetryBlockedReason({
    sending,
    settingsChanging: settings.changing,
    attachmentsBusy,
    runtimeReady,
    ...(voice.blockedReason === undefined ? {} : { voiceInput: voice.blockedReason }),
  });
  // 主スロットを送信と停止のどちらにするか (docs/ui-layout.md#入力欄の主ボタン送信と停止)
  const sendable = value.trim().length > 0 || hasAttachment || suggestion !== null;
  const action = composerAction({
    stopVisible,
    sendable,
    // アップロード中は「送るものがあるのに送れない」状態なので、停止を主スロットへ上げない
    sendBlocked: Boolean(settings.sendBlockedReason) || attachmentsBusy,
    stopPrimaryHeld: sendHold.held || voice.hold,
    voicePhase: voice.phase,
  });
  const stopPrimary = composerPrimaryStop(action);
  const showMicrophone = voiceInputAvailable && !voice.busy;
  // 待機件数の正は直上ブロック。ボタンは破棄する範囲だけを示し、数を二重に出さない
  const stopButton = (
    <button
      type="button"
      aria-label={queueDepth > 0 ? "停止（待機中の送信も破棄）" : "停止"}
      title={queueDepth > 0 ? "実行を中断し、待機中の送信も破棄します" : "実行を中断します"}
      // 主 / 控えの別を印で出す (描画のテストを色の class に依存させないため)
      data-stop-slot={stopPrimary ? "primary" : "secondary"}
      onClick={onStop}
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full transition-colors",
        // 円の大きさは送信と同じにする (入替えで位置と寸法が動くと、指が別の操作を拾う)。
        // 主 / 控えの差は塗りと枠だけにする
        stopPrimary
          ? "bg-accent text-on-accent hover:brightness-110"
          : "border border-line text-ink-soft hover:border-warn/50 hover:text-warn",
        singleColumn ? "size-9" : "size-8",
      )}
    >
      <StopIcon large />
    </button>
  );
  const sendButton = (
    <button
      type="submit"
      aria-label="送信"
      // 実行中の送信は中断ではなく待機キューへ積む。形の切替でここを取り違えないよう、送信の側に書く
      title={stopVisible && !settings.sendBlockedReason ? "実行中のため、待機キューに積んでから送信します" : undefined}
      disabled={
        !runtimeReady ||
        sending ||
        attachmentsBusy ||
        settings.changing ||
        voice.hold ||
        Boolean(settings.sendBlockedReason) ||
        !sendable
      }
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-on-accent transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45",
        singleColumn ? "size-9" : "size-8",
      )}
    >
      <ArrowUpIcon />
    </button>
  );
  // モデルが使えない理由は、popover の開閉に関係なく入力欄の下へ残す。開いている間は popover の中にも
  // 同じ文言を出すが、footnote の行を消すとコンポーザーの高さが動く (docs/ui-layout.md)。状態行の warn 色は気付きだけを示す
  const footnoteWarnings = [settings.modelWarning, settings.sendBlockedReason].filter((text): text is string =>
    Boolean(text),
  );
  // 音声の注記と会話の notice は同じ 1 行に並べる（状態行の下の行を増やすと composer の高さが動く）
  const shownNotice = [notice, voice.notice].filter((text): text is string => Boolean(text)).join(" / ") || undefined;
  const suggestionChip = suggestion ? (
    <SuggestionChip suggestion={suggestion} singleColumn={singleColumn} onClear={clearSuggestion} />
  ) : null;

  return (
    <footer className="w-full min-w-0">
      {/* 外装は native の dialog。拡大していない間は UA の `display: none` を class が打ち消し、いつもどおりの
          位置に置く (入力欄を mount し直すと下書き・カーソルの位置・IME の状態が消えるため。docs/ui-layout.md) */}
      <dialog
        ref={dialogRef}
        // 閉じている間は role=dialog を名乗らない (通常のブロックとして置く外装なので、読み上げの区切りにしない)
        role={expandedUi ? undefined : "presentation"}
        aria-label={expandedUi ? "メッセージ入力" : undefined}
        data-closing={expansion.expandPhase === "closing"}
        onCancel={expansion.cancel}
        onClick={expansion.backdropClick}
        onPointerDown={expansion.backdropPointerDown}
        className={cn(
          "composer-dialog text-ink",
          expandedUi
            ? "m-0 grid h-dvh max-h-none w-screen max-w-none place-items-center border-0 bg-transparent p-4"
            : singleColumn
              ? "px-3 pb-[max(8px,env(safe-area-inset-bottom))]"
              : "mx-auto max-w-220 px-6 pb-5 wide:px-8",
        )}
      >
        {/* 浮かせる基準は内容の欄 (padding の内側)。padding の外を基準にすると、狭い幅で箱が composer からはみ出す */}
        <div
          className={cn(
            "relative",
            // 拡大中は面 (枠・背景) を外側へ移し、中の form は高さを埋める行だけを持つ
            expandedUi &&
              cn(
                // 面は dialog の auto 列に載る grid item。content-based minimum を外さないと中身の固有幅
                // (textarea の cols) が列の最小に効き、狭い幅で面が viewport の外まで伸びる
                "flex h-full max-h-[min(88dvh,760px)] w-full max-w-220 min-w-0 flex-col rounded-xl border bg-panel shadow-panel",
                singleColumn ? "p-2" : "p-2.5",
                dropKind !== null ? "border-accent" : "border-line-strong",
              ),
          )}
          // 受け口は面ごと (拡大中は form の外側に余白があるため、form にだけ置くとその余白でブラウザーが開く)
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={() => setDropKind(null)}
          onDrop={handleDrop}
        >
          <QueuedSends sends={queuedSends ?? []} singleColumn={singleColumn} onCancel={onCancelQueued} />
          <ComposerStatus
            activity={activity}
            activityState={activityState}
            thinkingText={thinkingText}
            sending={sending}
            runningSince={runningSince}
            runTools={runTools}
            queueDepth={queueDepth}
            context={context}
            modelSlot={
              <ModelEffortPicker
                settings={settings}
                singleColumn={singleColumn}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                onChangeModel={onChangeModel}
                onChangeThinkingLevel={onChangeThinkingLevel}
              />
            }
            onCompact={onCompact}
            compactDisabled={settings.compactDisabled}
            compactDisabledReason={settings.compactDisabledReason}
            singleColumn={singleColumn}
            runStatus={runStatus}
            runError={runError}
            notice={shownNotice}
            onRetry={onRetry}
            retryDisabled={retryBlockedReason !== undefined}
            retryDisabledReason={retryBlockedReason}
          />
          <form
            onSubmit={handleSubmit}
            className={cn(
              "relative",
              // 拡大中は面 (枠・背景) が外側の容器へ移る。残りの高さを入力欄の行へ渡す
              expandedUi
                ? "flex min-h-0 flex-1 flex-col gap-2"
                : cn(
                    // 単一列 Grid の auto 列は、行の中身の intrinsic 幅 (欄と textarea) で form の外まで
                    // 伸びる。minmax(0, 1fr) で form 幅に拘束する (docs/ui-layout.md)
                    "grid grid-cols-1 rounded-xl border bg-panel/90 shadow-panel",
                    dropKind !== null ? "border-accent" : "border-line-strong",
                    singleColumn ? "gap-1.5 p-2" : "gap-2 p-2.5",
                  ),
            )}
          >
            {/* 拡大のボタンが右上に浮く分、1 行目の右端を空けておく (見出しのチップと重ねない) */}
            <div
              className={cn("flex flex-wrap items-center pr-9", singleColumn ? "gap-2" : "gap-x-3 gap-y-1.5 px-0.5")}
            >
              <AgentField
                agents={agents}
                agentId={agentId}
                singleColumn={singleColumn}
                sessionAgent={sessionAgent}
                onChangeAgent={onChangeAgent}
              />
              <SkillPicker
                state={skills}
                rootCwd={rootCwd}
                singleColumn={singleColumn}
                open={skillsOpen}
                onOpenChange={handleSkillsOpenChange}
                onSelect={insertSkillCommand}
                onReload={onReloadSkills}
              />
              {/* 添付はスキルと同じ大きさで並べ、右上の拡大ボタンと重ねない（1 行目の右端は pr-9 で空ける） */}
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
                  "grid shrink-0 cursor-pointer place-items-center rounded-full border border-line bg-raised text-ink-faint transition-colors hover:text-ink-soft",
                  singleColumn ? "size-9" : "size-7",
                )}
              >
                <ClipIcon />
              </button>
            </div>
            <AttachmentChips
              attachments={attachments}
              rootCwd={rootCwd}
              singleColumn={singleColumn}
              onRemove={onRemoveAttachment}
            />
            {singleColumn ? suggestionChip : null}
            <div className={cn("flex items-end", singleColumn ? "gap-2" : "gap-2.5", expandedUi && "min-h-0 flex-1")}>
              {singleColumn ? null : suggestionChip}
              <textarea
                ref={inputRef}
                rows={1}
                value={value}
                placeholder={
                  suggestion !== null
                    ? "続きを入力…"
                    : runtimeReady
                      ? singleColumn
                        ? "メッセージを入力…"
                        : "メッセージを入力… (Enterで送信 / Shift+Enterで改行)"
                      : "APIキーを設定すると送信できます"
                }
                className={cn(
                  // min-w-0 が無いと cols 既定値の intrinsic 幅 (textarea の自動最小サイズ) が下限になり、
                  // 狭い viewport で入力欄が縮まずに送信 / 添付ボタンを画面外へ押し出す
                  "min-w-0 flex-1 resize-none scrollbar-thin bg-transparent px-0.5 leading-normal text-ink outline-none placeholder:text-ink-ghost",
                  // 拡大中は行の高さまで伸ばす (上限は面が持つ。text-md は singleColumn の拡大で focus しても
                  // iOS Safari にズームさせないために残す)
                  expandedUi
                    ? cn("self-stretch", singleColumn ? "py-1.5 text-md" : "py-1")
                    : singleColumn
                      ? "max-h-30 min-h-9 py-1.5 text-md"
                      : "max-h-45 min-h-6 py-1",
                )}
                enterKeyHint={singleColumn ? "enter" : "send"}
                onChange={(event) => applyValue(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                aria-label={expanded ? "入力欄を元の大きさに戻す" : "入力欄を拡大"}
                aria-expanded={expanded}
                title={expanded ? "入力欄を元の大きさに戻す" : "入力欄を拡大"}
                onClick={expansion.toggle}
                className={cn(
                  "absolute top-1 right-1 grid cursor-pointer place-items-center rounded-md text-ink-ghost transition-colors hover:text-accent-text",
                  singleColumn ? "size-8" : "size-7",
                )}
              >
                {expanded ? <CollapseIcon /> : <ExpandIcon />}
              </button>
              {/* 入力欄の行は [textarea] [マイク] [主ボタン]。マイクは録音・接続・確定待ちの間は隠し、
                  その間の主スロットを音声の操作が占有する (docs/ui-layout.md) */}
              {showMicrophone ? <VoiceInputStartButton singleColumn={singleColumn} onClick={voice.start} /> : null}
              {composerSecondaryStop(action) && stopVisible ? stopButton : null}
              {stopPrimary ? (
                stopButton
              ) : action === "voiceCancel" ? (
                <VoiceInputCancelButton singleColumn={singleColumn} onClick={voice.cancel} />
              ) : action === "voiceStop" ? (
                <VoiceInputStopButton singleColumn={singleColumn} remaining={voice.remaining} onClick={voice.stop} />
              ) : action === "voiceFinalizing" ? (
                <VoiceInputFinalizingButton singleColumn={singleColumn} />
              ) : (
                sendButton
              )}
            </div>
          </form>
          {/* footnote は警告の理由だけを持ち、停止の導線は入力欄の行にある */}
          {singleColumn ? (
            footnoteWarnings.length > 0 ? (
              <div className="px-1 pt-1.5 text-2xs text-ink-ghost">
                <span className="break-words text-warn">{footnoteWarnings.join(" / ")}</span>
              </div>
            ) : null
          ) : (
            <div className="px-1 pt-2 text-2xs text-ink-ghost">
              <span className="break-words">
                送信後もブラウザを閉じても処理は続きます
                {footnoteWarnings.length > 0 ? (
                  <span className="ml-1 text-warn">{footnoteWarnings.join(" / ")}</span>
                ) : null}
              </span>
            </div>
          )}
        </div>
      </dialog>
    </footer>
  );
}
