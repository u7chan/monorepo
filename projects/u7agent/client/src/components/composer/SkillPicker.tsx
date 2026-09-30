import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
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
import type { SessionSkillsState } from "../../hooks/useSessionSkills";
import { SkillListIcon } from "../icons";

/**
 * チャットのスキルピッカー。トリガー (Model / Effort と同じ行) と、その上へ開く popover を 1 つで持つ。
 * 一覧を `form` の行に置くと開閉のたびにコンポーザーが伸び、メッセージ領域がその分だけ縮むため、
 * popover (`top layer`) に出してレイアウトを動かさない (docs/ui-layout.md)。
 *
 * 位置と大きさは `client/src/lib/skillPicker.ts` が決める。開閉は native popover に任せ、外側クリックと
 * Escape の終了は標準の light dismiss、選択 / Tab での退出は `hidePopover()` を通す。本体は常時 mount する
 * (React の条件付き mount で出し入れすると標準の開閉と二重管理になる)。開いたままの状態は `open` を
 * 正として呼び出し側が畳めるようにする (送信で閉じる経路がある)。
 */
export function SkillPicker({
  state,
  rootCwd,
  compact,
  open,
  onOpenChange,
  onSelect,
  onReload,
}: {
  state: SessionSkillsState;
  /** ワークスペース root の絶対パス (health.cwd)。場所を root 相対で示すのに使う */
  rootCwd: string;
  compact: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (name: string) => void;
  onReload: () => void;
}) {
  const pickerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const body = bodyRef.current;
    const trigger = triggerRef.current;
    if (popover === null || body === null || trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    // 幅と高さの上限を先に確定させる: 折り返しと内部スクロールが決まり、rect が最終の大きさになる
    const width = skillPickerWidth(viewport.width);
    const { above, maxHeight } = skillPickerLayout(anchor, viewport, compact);
    popover.style.width = `${width}px`;
    // 上限はスクロールする本文に当てる。popover は flex にできない (UA の「閉じている間は display: none」を
    // ユーティリティの display が打ち消す) ため、注記の高さは本文から引いて残す
    const chrome = (footerRef.current?.getBoundingClientRect().height ?? 0) + 2;
    body.style.maxHeight = `${Math.max(0, maxHeight - chrome)}px`;
    popover.style.left = `${skillPickerLeft(anchor, width, viewport.width)}px`;
    popover.style.top = `${skillPickerTop(anchor, popover.getBoundingClientRect().height, above, viewport.height)}px`;
  }, [compact]);

  // 開いている間は commit のたびに置き直す。window の resize ハンドラは React の再レンダー
  // (compact ⇄ desktop の切替など) より先に走り、動く前の rect を読んでしまう
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
  // (再取得の完了などの再描画で勝手に開き直さない)
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
    // 閉じている間の rect は 0 なので、出してから置く。取り直しは呼び出し側 (Composer) が行う
    onOpenChange(true);
    popover.showPopover();
    place();
  };

  /** 一覧の選択はコマンドの挿入だけ。本文の展開は送信時に BFF が行う (docs/api-sessions.md) */
  const select = (name: string) => {
    popoverRef.current?.hidePopover();
    onSelect(name);
  };

  // Escape は native の light dismiss も閉じるが、App の Escape (設定ページからチャットへ戻る) へ
  // 届かせないため、トリガーとポップアップの両方を含むここで止める
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
  };

  /**
   * フォーカスが外へ出たら閉じる。native popover は Tab では閉じないため自前で見る。
   * 監視は**トリガーとポップアップの両方**を包むここに置く: 開いた直後のフォーカスはトリガーにあり、
   * Shift+Tab や (行が無いときの) Tab はポップアップの中を経由せずに外へ出るため、
   * ポップアップ側だけの `onBlur` では取りこぼす。
   */
  const onFocusOut = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    // トリガー → 行、行 → 行の移動は閉じる操作ではない (トリガーへ戻る移動もここに含まれる)
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    popoverRef.current?.hidePopover();
  };

  return (
    // トリガーとポップアップを 1 つのフォーカス範囲として扱う (display: contents は行の flex 配置を変えない)
    <span className="contents" onKeyDown={onKeyDown} onBlur={onFocusOut}>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pickerId}
        aria-label="スキル一覧"
        title={triggerTitle}
        popoverTarget={pickerId}
        popoverTargetAction="toggle"
        disabled={!enabled}
        onClick={toggle}
        className={cn(
          "grid shrink-0 cursor-pointer place-items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-45",
          compact ? "size-9" : "size-7",
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
        ref={popoverRef}
        id={pickerId}
        popover="auto"
        role="dialog"
        aria-label="スキル一覧"
        className="popover-panel fixed inset-auto m-0 overflow-hidden rounded-lg border border-line bg-panel shadow-panel"
      >
        <div ref={bodyRef} className="grid min-w-0 scrollbar-thin gap-2 overflow-x-hidden overflow-y-auto px-2.5 py-2">
          {/* 状態の 1 行。テキストの末尾に再取得を流す (エラーが長いときは折り返した行の末尾に付く) */}
          {notice ? (
            <p className={cn("text-2xs break-words", notice.warn ? "text-warn" : "text-ink-faint")}>
              {notice.text}
              {notice.retry ? (
                <button
                  type="button"
                  onClick={onReload}
                  className="ml-1.5 cursor-pointer rounded-full border border-line bg-raised px-2 py-0.5 align-baseline text-2xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent-text"
                >
                  再取得
                </button>
              ) : null}
            </p>
          ) : null}

          {groups.map((group) => (
            <div key={group.scope} className="grid min-w-0 gap-1">
              <span className="font-sans text-3xs tracking-wide text-ink-faint uppercase">
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
                          "grid w-full min-w-0 cursor-pointer gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:border-accent/50 hover:bg-raised",
                          skill.shadowed ? "border-line/70 bg-transparent opacity-70" : "border-line bg-raised",
                        )}
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="min-w-0 truncate text-xs font-medium text-ink-strong">{skill.name}</span>
                          <span className="ml-auto shrink-0 font-mono text-3xs text-ink-ghost">
                            {skillCommandText(skill.name).trim()}
                          </span>
                        </span>
                        {skill.description ? (
                          <span className="min-w-0 truncate text-2xs text-ink-soft">{skill.description}</span>
                        ) : null}
                        {warning ? <span className="text-3xs text-warn">{warning}</span> : null}
                        {skill.disableModelInvocation ? (
                          <span className="text-3xs text-ink-faint">{SESSION_SKILL_DISABLED_NOTE}</span>
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
          <p ref={footerRef} className="border-t border-line px-2.5 py-1.5 text-3xs text-ink-ghost">
            {SESSION_SKILL_BODY_NOTE}
          </p>
        ) : null}
      </div>
    </span>
  );
}
