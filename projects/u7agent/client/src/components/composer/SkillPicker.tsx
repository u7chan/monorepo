import { useCallback, useEffect, useId, useRef } from "react";
import { cn } from "../../lib/cn";
import {
  SESSION_SKILL_BODY_NOTE,
  SESSION_SKILL_DISABLED_NOTE,
  SESSION_SKILL_SCOPE_LABEL,
  SESSION_SKILL_UNAVAILABLE_NOTE,
  groupSessionSkills,
  sessionSkillLocation,
  sessionSkillsNotice,
  sessionSkillWarning,
  skillCommandText,
} from "../../lib/sessionSkills";
import { skillPickerLayout, skillPickerLeft, skillPickerTop, skillPickerWidth } from "../../lib/skillPicker";
import { POPOVER_MARGIN } from "../../lib/popoverPlacement";
import { usePopoverShell, type PopoverPlaceInput } from "../../hooks/usePopoverShell";
import type { SessionSkillsState } from "../../hooks/useSessionSkills";
import { SkillListIcon } from "../icons";

/**
 * チャットのスキルピッカー。行に置くと開閉でコンポーザーが伸びるため popover (top layer) に出し、
 * 開閉は native popover に任せる (常時 mount。位置は lib/skillPicker.ts。docs/ui-layout.md)。
 */
export function SkillPicker({
  state,
  rootCwd,
  singleColumn,
  open,
  onOpenChange,
  onSelect,
  onReload,
}: {
  state: SessionSkillsState;
  /** ワークスペース root の絶対パス (health.cwd)。場所を root 相対で示すのに使う */
  rootCwd: string;
  singleColumn: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (name: string) => void;
  onReload: () => void;
}) {
  const pickerId = useId();
  // 本文と注記の高さは place / size が測るので、要素はここで持つ (popover の開閉は hook が持つ)
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLParagraphElement | null>(null);
  const groups = state.status === "ready" ? groupSessionSkills(state.skills) : [];
  const notice = sessionSkillsNotice(state);
  const enabled = state.status !== "unavailable";
  // 失敗している間はトリガーを warn 色にし、理由を title へ出す (開かなくても気付ける。本文の 1 行と同じ文言)
  const triggerTitle =
    state.status === "unavailable"
      ? SESSION_SKILL_UNAVAILABLE_NOTE
      : notice?.warn
        ? `スキル一覧（${notice.text}）`
        : "スキル一覧（選択で /skill: を入力）";

  /**
   * 幅と高さの上限を先に確定させる (折り返しと内部スクロールが決まり rect が最終の大きさになる)。
   * 上限はスクロールする本文に当て、注記の高さは本文から引いて残す (popover は flex にできない)。
   */
  const sizePicker = useCallback(
    ({ popover, trigger, viewport }: PopoverPlaceInput) => {
      if (trigger === null) return;
      const anchor = trigger.getBoundingClientRect();
      const { maxHeight } = skillPickerLayout(anchor, viewport, singleColumn);
      popover.style.width = `${skillPickerWidth(viewport.width)}px`;
      const chrome = (footerRef.current?.getBoundingClientRect().height ?? 0) + 2;
      if (bodyRef.current !== null) bodyRef.current.style.maxHeight = `${Math.max(0, maxHeight - chrome)}px`;
    },
    [singleColumn],
  );

  const place = useCallback(
    ({ popover, trigger, viewport }: PopoverPlaceInput) => {
      if (trigger === null) return null;
      const anchor = trigger.getBoundingClientRect();
      const width = skillPickerWidth(viewport.width);
      const { above } = skillPickerLayout(anchor, viewport, singleColumn);
      return {
        left: skillPickerLeft(anchor, width, viewport.width),
        top: skillPickerTop(anchor, popover.getBoundingClientRect().height, above, viewport.height),
      };
    },
    [singleColumn],
  );

  // 開いた直後の焦点はトリガーに残す (一覧は Tab で入る)。開閉は親が持ち、標準の close も
  // `onOpenChange` で伝わる
  const { triggerProps, popoverProps, containerProps, close } = usePopoverShell(place, POPOVER_MARGIN, {
    reposition: ({ place: placeNow }) => placeNow(),
    exitOnBlur: ({ close: closeNow }) => closeNow(),
    size: sizePicker,
    // 開いた直後の焦点はトリガーに残す (一覧は Tab で入る)
    openFocus: () => null,
    onOpenChange,
  });

  /** 一覧の選択はコマンドの挿入だけ。本文の展開は送信時に BFF が行う (docs/api-session-turns.md) */
  const select = (name: string) => {
    close();
    onSelect(name);
  };

  // 親から畳まれたとき (送信の成立) だけ閉じる。開くのはトリガーだけにする
  // (再取得の完了などの再描画で勝手に開き直さない)
  useEffect(() => {
    if (!open) close();
  }, [close, open]);

  return (
    // トリガーとポップアップを 1 つのフォーカス範囲として扱う (display: contents は行の flex 配置を変えない)
    <span className="contents" {...containerProps}>
      <button
        type="button"
        {...triggerProps}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pickerId}
        aria-label="スキル一覧"
        title={triggerTitle}
        popoverTarget={pickerId}
        popoverTargetAction="toggle"
        disabled={!enabled}
        className={cn(
          "grid shrink-0 cursor-pointer place-items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-45",
          singleColumn ? "size-9" : "size-7",
          state.status === "error" || (state.status === "ready" && state.reloadError !== undefined)
            ? "border-warn/50 text-warn"
            : open
              ? "border-accent/50 bg-accent-wash text-accent-text"
              : "border-line bg-raised text-ink-faint hover:text-ink-soft",
        )}
      >
        <SkillListIcon />
      </button>

      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置と幅は place() が left / top / width / max-height を直接書く */}
      <div
        {...popoverProps}
        id={pickerId}
        popover="auto"
        role="dialog"
        aria-label="スキル一覧"
        className="popover-panel fixed inset-auto m-0 overflow-hidden rounded-lg border border-line bg-panel shadow-panel"
      >
        <div ref={bodyRef} className="grid min-w-0 scrollbar-thin gap-2 overflow-x-hidden overflow-y-auto px-2.5 py-2">
          {/* 状態の 1 行。テキストの末尾に再取得を流す (エラーが長いときは折り返した行の末尾に付く) */}
          {notice ? (
            <p
              className={cn("text-2xs break-words singleColumn:text-xs", notice.warn ? "text-warn" : "text-ink-faint")}
            >
              {notice.text}
              {notice.retry ? (
                <button
                  type="button"
                  onClick={onReload}
                  className="ml-1.5 cursor-pointer rounded-full border border-line bg-raised px-2 py-0.5 align-baseline text-2xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text singleColumn:text-xs"
                >
                  再取得
                </button>
              ) : null}
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.scope} className="grid min-w-0 gap-1">
              <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase singleColumn:text-1xs">
                {group.label}（{group.skills.length}）
              </span>
              <ul className="grid min-w-0 gap-1">
                {group.skills.map((skill) => {
                  const warning = sessionSkillWarning(skill, rootCwd);
                  const location = sessionSkillLocation(skill, rootCwd);
                  return (
                    <li key={`${skill.scope}:${skill.name}`} className="min-w-0">
                      <button
                        type="button"
                        // 同名は優先順位で一意に解決されるため、行の識別は名前で足りる
                        aria-label={`${skill.name}（${SESSION_SKILL_SCOPE_LABEL[skill.scope]}）を /skill: として入力`}
                        onClick={() => select(skill.name)}
                        // 説明は 1 行に切るので、全文と置き場は title へ逃がす (hover で読める)
                        title={[skill.description, location, warning].filter((line) => Boolean(line)).join("\n")}
                        className={cn(
                          "grid w-full min-w-0 cursor-pointer gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:border-accent/50 hover:bg-raised singleColumn:min-h-11",
                          skill.shadowed ? "border-line/70 bg-transparent opacity-70" : "border-line bg-raised",
                        )}
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="min-w-0 truncate text-xs font-medium text-ink-strong singleColumn:text-sm">
                            {skill.name}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-3xs text-ink-ghost singleColumn:text-1xs">
                            {skillCommandText(skill.name).trim()}
                          </span>
                        </span>
                        {skill.description ? (
                          <span className="min-w-0 truncate text-2xs text-ink-soft singleColumn:text-xs">
                            {skill.description}
                          </span>
                        ) : null}
                        {warning ? <span className="text-3xs text-warn singleColumn:text-1xs">{warning}</span> : null}
                        {skill.disableModelInvocation ? (
                          <span className="text-3xs text-ink-faint singleColumn:text-1xs">
                            {SESSION_SKILL_DISABLED_NOTE}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {groups.length > 0 ? (
          <p
            ref={footerRef}
            className="border-t border-line px-2.5 py-1.5 text-3xs text-ink-ghost singleColumn:text-1xs"
          >
            {SESSION_SKILL_BODY_NOTE}
          </p>
        ) : null}
      </div>
    </span>
  );
}
