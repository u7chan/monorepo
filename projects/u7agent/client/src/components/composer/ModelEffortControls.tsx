import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { effortChoices, effortLabel, type ComposerSettings } from "../../lib/composerSettings";
import { cn } from "../../lib/cn";
import { modelChoices, unavailableModelChoice } from "../../lib/modelChoices";
import {
  popoverAvailableHeight,
  popoverLeft,
  popoverOpensAbove,
  popoverTop,
  popoverWidth,
} from "../../lib/popoverPlacement";
import type { ModelRef, ThinkingLevel } from "../../types";
import { SelectField } from "../SelectField";
import { ChevronDownIcon } from "../icons";
import { fieldLabelClass, fieldNameClass } from "./fieldStyles";

/** ポップアップの幅の上限 (px)。候補の選択肢と注意文が読める幅 */
const MODEL_EFFORT_PICKER_WIDTH = 320;

/**
 * コンポーザーの Model / Effort 切り替え。トリガー (入力欄の上の状態行) と、その上へ開く popover を
 * 1 つで持つ。設定の入力を行に置くと開閉のたびにコンポーザーが伸び、メッセージ領域がその分だけ縮むため、
 * popover (top layer) に出してレイアウトを動かさない (docs/ui-layout.md)。位置と大きさは
 * `client/src/lib/popoverPlacement.ts` が決める (スキル一覧と同じ計算)。開閉は native popover に任せ、
 * 外側クリックと Escape の終了は標準の light dismiss、フォーカスが外へ出たときは `hidePopover()` を通す。
 * 本体は常時 mount する (React の条件付き mount で出し入れすると標準の開閉と二重管理になる)。
 */
export function ModelEffortPicker({
  settings,
  singleColumn,
  open,
  onOpenChange,
  onChangeModel,
  onChangeThinkingLevel,
}: {
  settings: ComposerSettings;
  singleColumn: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
}) {
  const pickerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // 注意文は popover の中だけに出す。畳んでいるときはモデルが使えない警告だけを入力欄の下へ残す
  const notice = settings.modelWarning ?? settings.effortNotice;
  const label = settings.modelLabel ?? "未選択";
  // 操作が要る壊れ状態は、実効モデルが候補に無いときと未選択で同じ
  const warn = settings.modelWarning !== undefined || settings.modelLabel === undefined;
  const current = settings.effortLabel ? `${label} - ${settings.effortLabel}` : label;
  // 開いても選べるモデルが無い導線を残さない。実行中・設定変更中も開ける (中の select が無効のまま)
  const unavailable = settings.modelOptions.length === 0 && !settings.model;

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    // 幅と高さの上限を先に確定させる: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
    const above = popoverOpensAbove(anchor, viewport.height);
    const width = popoverWidth(MODEL_EFFORT_PICKER_WIDTH, viewport.width);
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${popoverAvailableHeight(anchor, viewport.height, above)}px`;
    popover.style.left = `${popoverLeft(anchor, width, viewport.width)}px`;
    popover.style.top = `${popoverTop(anchor, popover.getBoundingClientRect().height, above, viewport.height)}px`;
  }, []);

  // 開いている間は commit のたびに置き直す。window の resize ハンドラは React の再レンダー
  // (singleColumn ⇄ desktop の切替など) より先に走り、動く前の rect を読んでしまう
  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss / Tab での退出) をここで観測して親へ写す。
  // 開くきっかけはトリガーだけなので、開いた通知はここでは送らない (押下と `toggle` で二重に伝えない)
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "open") return;
      onOpenChange(false);
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [onOpenChange]);

  // 親から畳まれたとき (送信の成立) だけ popover を閉じる。開くのはトリガーだけにする
  // (設定変更の完了などの再描画で勝手に開き直さない)
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null || !popover.matches(":popover-open")) return;
    if (!open) popover.hidePopover();
  }, [open]);

  // 開いている間だけ位置を取り直す。scroll は capture で受けないと親のスクロール枠の分を拾えない
  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null) return;
    // popoverTarget はトリガー自身の押下を light dismiss の対象外にするためだけに付ける。既定の activation
    // behavior は同じトグルを二重に走らせるので止め、開閉を showPopover / hidePopover に寄せる
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    onOpenChange(true);
    popover.showPopover();
    place();
  };

  // Escape は native の light dismiss も閉じるが、App の Escape (設定ページからチャットへ戻る) へ
  // 届かせないため、トリガーとポップアップの両方を含むここで止める
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
  };

  /**
   * フォーカスが外へ出たら閉じる。native popover は Tab では閉じないため自前で見る。
   * 監視は**トリガーとポップアップの両方**を包むここに置く: 開いた直後のフォーカスはトリガーにあり、
   * Shift+Tab はポップアップの中を経由せずに外へ出るため、ポップアップ側だけの `onBlur` では取りこぼす。
   */
  const onFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    // トリガー → select、select → select の移動は閉じる操作ではない (トリガーへ戻る移動もここに含まれる)
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    popoverRef.current?.hidePopover();
  };

  return (
    // トリガーとポップアップを 1 つのフォーカス範囲として扱う (display: contents は行の flex 配置を変えない)
    <div className="contents" onKeyDown={onKeyDown} onBlur={onFocusOut}>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pickerId}
        aria-label={`モデルと Effort の設定（${current}）`}
        title={settings.model}
        popoverTarget={pickerId}
        popoverTargetAction="toggle"
        onClick={toggle}
        disabled={unavailable}
        className={cn(
          "composer-model-trigger hover:text-accent-text focus-visible:text-accent-text",
          warn ? "text-warn" : open ? "text-accent-text" : "text-ink-faint",
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {settings.effortLabel ? <span className="shrink-0">{`- ${settings.effortLabel}`}</span> : null}
        {unavailable ? null : <ChevronDownIcon />}
      </button>

      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置と幅は place() が left / top / width / max-height を直接書く */}
      <div
        ref={popoverRef}
        id={pickerId}
        popover="auto"
        role="dialog"
        aria-label="モデルと Effort"
        className="popover-panel fixed inset-auto m-0 scrollbar-thin overflow-y-auto rounded-lg border border-line bg-panel p-2.5 shadow-panel"
      >
        <div className="grid min-w-0 gap-2">
          <ModelEffortFields
            settings={settings}
            singleColumn={singleColumn}
            onChangeModel={onChangeModel}
            onChangeThinkingLevel={onChangeThinkingLevel}
          />
          {notice ? <p className="m-0 min-w-0 text-2xs break-words text-warn singleColumn:text-1xs">{notice}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function ModelEffortFields({
  settings,
  singleColumn,
  onChangeModel,
  onChangeThinkingLevel,
}: {
  settings: ComposerSettings;
  singleColumn: boolean;
  onChangeModel: (model: ModelRef) => void;
  onChangeThinkingLevel: (level: ThinkingLevel) => void;
}) {
  const choices = useMemo(() => {
    const list = modelChoices(settings.modelOptions);
    // 実効値が候補に無い（利用不可）ときも現在値を表示できるようにする
    if (settings.model && !list.some((choice) => choice.value === settings.model)) {
      list.push(unavailableModelChoice(settings.model));
    }
    return list;
  }, [settings.modelOptions, settings.model]);
  // SDK が補正した実効値が候補に無くても表示できるようにする (順番は段階順のまま)
  const effortLevels = useMemo(
    () => effortChoices(settings.thinkingLevels, settings.thinkingLevel),
    [settings.thinkingLevels, settings.thinkingLevel],
  );

  const modelDisabled = settings.disabled || settings.modelOptions.length === 0;
  const effortDisabled = settings.disabled || !settings.supportsThinking || effortLevels.length === 0;

  const handleModelChange = (next: string) => {
    const choice = choices.find((candidate) => candidate.value === next);
    if (!choice?.model) return;
    onChangeModel(choice.model);
  };

  return (
    <>
      <label className={fieldLabelClass}>
        <span className={fieldNameClass}>Model</span>
        <SelectField
          aria-label="モデルを選択"
          density="sm"
          singleColumn={singleColumn}
          wrapperClassName="min-w-0 flex-1"
          value={settings.model ?? ""}
          disabled={modelDisabled}
          onChange={(event) => handleModelChange(event.currentTarget.value)}
        >
          {settings.model ? null : <option value="">未選択</option>}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </SelectField>
      </label>
      <label className={fieldLabelClass}>
        <span className={fieldNameClass}>Effort</span>
        <SelectField
          aria-label="Effort を選択"
          density="sm"
          singleColumn={singleColumn}
          wrapperClassName="min-w-0 flex-1"
          value={settings.thinkingLevel ?? ""}
          disabled={effortDisabled}
          onChange={(event) => onChangeThinkingLevel(event.currentTarget.value as ThinkingLevel)}
        >
          {settings.thinkingLevel ? null : <option value="">未選択</option>}
          {effortLevels.map((level) => (
            <option key={level} value={level}>
              {effortLabel(level)}
            </option>
          ))}
        </SelectField>
      </label>
    </>
  );
}
