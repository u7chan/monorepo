import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { AGENT_PICKER_MARGIN, agentPickerPlacement, nextAgentOptionIndex } from "../../lib/agentPicker";
import { cn } from "../../lib/cn";
import type { AgentDef } from "../../types";
import { AgentIcon } from "../AgentIcon";
import { MenuItem } from "../MenuItem";

/**
 * コンポーザーのエージェント選択。native `<select>` の `<option>` には画像を描画できないため、
 * button + native `popover="auto"` の listbox で行にアイコンと名前を出す。外側クリックと Escape の
 * 終了は標準の light dismiss に任せ、自前で閉じる経路（選択 / Tab での退出）だけ `hidePopover()` を通す。
 * 本体は常時 mount する（React の条件付き mount で出し入れすると標準の開閉と二重管理になる）。
 */
export function AgentPicker({
  agents,
  agentId,
  compact,
  onChangeAgent,
}: {
  agents: AgentDef[];
  agentId: string;
  compact: boolean;
  onChangeAgent: (agentId: string) => void;
}) {
  const pickerId = useId();
  const triggerId = `${pickerId}-trigger`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  // トリガーの押下は click より先にフォーカスを奪う。その focusout で閉じると直後の click が
  // 開き直してトグルが効かないため、押している間だけ focusout での終了を保留する
  const pressingTriggerRef = useRef(false);
  const selected = agents.find((agent) => agent.id === agentId);
  const selectedIndex = agents.findIndex((agent) => agent.id === agentId);

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    const anchor = trigger.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    // 幅を先に確定させる: max-width で折り返しと内部スクロールが決まり、rect が最終の大きさになる
    popover.style.minWidth = `${anchor.width}px`;
    popover.style.maxWidth = `${viewport.width - AGENT_PICKER_MARGIN * 2}px`;
    const { left, top } = agentPickerPlacement(anchor, popover.getBoundingClientRect(), viewport);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }, []);

  // 開いている間は commit のたびに置き直す。window の resize ハンドラは React の再レンダー
  // (compact ⇄ desktop の切替など) より先に走り、動く前の rect を読んでしまう
  useLayoutEffect(() => {
    if (open) place();
  });

  // 開閉の正は popover の状態。標準の close (Escape / light dismiss) もここで観測して aria-expanded へ写す
  useEffect(() => {
    const popover = popoverRef.current;
    if (popover === null) return;
    const onToggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, []);

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

  const focusSelected = () => {
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    items[selectedIndex < 0 ? 0 : selectedIndex]?.focus();
  };

  const openPicker = () => {
    const popover = popoverRef.current;
    if (popover === null) return;
    // 開いた状態で ↑↓ を受けても showPopover を二重に呼ばない (InvalidStateError を避ける)
    if (popover.matches(":popover-open")) {
      focusSelected();
      return;
    }
    popover.showPopover();
    place();
    focusSelected();
  };

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const popover = popoverRef.current;
    if (popover === null) return;
    pressingTriggerRef.current = false;
    // popoverTarget はトリガー自身の押下を light dismiss の対象外にするためだけに付ける。既定の activation
    // behavior は同じトグルを二重に走らせるので止め、開閉を showPopover / hidePopover に寄せる
    event.preventDefault();
    if (popover.matches(":popover-open")) {
      popover.hidePopover();
      return;
    }
    openPicker();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // 既定動作 (ページのスクロール) を止め、native select と同じく選択中の行から入る
    event.preventDefault();
    openPicker();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
      event.stopPropagation();
      return;
    }
    const direction =
      event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowUp"
          ? "previous"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    // Enter / Space は native の button に任せる
    if (direction === null) return;
    // 既定動作 (リストの外のスクロール) を止める
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextAgentOptionIndex(current, items.length, direction)]?.focus();
  };

  const onListBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && popoverRef.current?.contains(next)) return;
    if (next === triggerRef.current && pressingTriggerRef.current) {
      // トリガーへの押下で移るフォーカスは閉じる操作ではない (閉じるかどうかは click 側が決める)
      pressingTriggerRef.current = false;
      return;
    }
    // native popover は Tab では閉じないため、外へのフォーカス移動は自前で閉じる
    popoverRef.current?.hidePopover();
  };

  const selectAgent = (next: string) => {
    if (next !== agentId) onChangeAgent(next);
    // フォーカスは外さない: blur すると native の復帰が起きず、トリガーへ戻らない
    popoverRef.current?.hidePopover();
  };

  return (
    <>
      <span
        className={cn("relative inline-flex min-w-0 items-center", compact ? "min-w-0 flex-1" : "max-w-50 min-w-0")}
      >
        <button
          type="button"
          ref={triggerRef}
          id={triggerId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={pickerId}
          aria-label={selected === undefined ? "エージェントを選択" : `エージェントを選択（${selected.name}）`}
          popoverTarget={pickerId}
          popoverTargetAction="toggle"
          disabled={agents.length === 0}
          onPointerDown={() => {
            pressingTriggerRef.current = true;
          }}
          onPointerUp={() => {
            pressingTriggerRef.current = false;
          }}
          onPointerCancel={() => {
            pressingTriggerRef.current = false;
          }}
          onClick={toggle}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            "field peer grid w-full cursor-pointer py-1 pr-8 pl-6.5 text-left disabled:cursor-not-allowed disabled:opacity-55",
            compact ? "text-md" : "text-1xs",
          )}
        >
          {/* 不可視の sizer を全候補ぶん同じセルに重ね、実際の描画幅の最大値を欄の幅にする。文字数では
              幅の広い名前を取りこぼし、選択のたびに欄と chevron が動く (選択で幅を動かさない) */}
          {agents.map((agent) => (
            <span key={agent.id} aria-hidden="true" className="invisible col-start-1 row-start-1 truncate">
              {agent.name}
            </span>
          ))}
          <span className="col-start-1 row-start-1 min-w-0 truncate">{selected?.name ?? ""}</span>
        </button>
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center peer-disabled:opacity-55">
          <AgentIcon icon={selected?.icon} variant="inline" />
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-2.5 size-3 shrink-0 text-ink-faint peer-disabled:opacity-55"
        >
          <path d="M4 6.75 8 10.75 12 6.75" />
        </svg>
      </span>
      {/* popover の UA 既定 (fixed 以外に margin / border / padding / overflow を持つ) を打ち消してから
          テーマのトークンを当てる。位置と幅は place() が left / top / min-width / max-width を直接書く */}
      <div
        ref={popoverRef}
        id={pickerId}
        popover="auto"
        role="listbox"
        aria-labelledby={triggerId}
        onKeyDown={onListKeyDown}
        onBlur={onListBlur}
        className="fixed inset-auto m-0 w-max overflow-visible rounded-lg border border-line bg-panel p-1 shadow-panel"
      >
        <div className="max-h-64 scrollbar-thin overflow-y-auto">
          {agents.map((agent, index) => (
            <MenuItem
              key={agent.id}
              ref={(element) => {
                itemsRef.current[index] = element;
              }}
              role="option"
              tabIndex={-1}
              icon={<AgentIcon icon={agent.icon} variant="list" />}
              label={agent.name}
              selected={agent.id === agentId}
              onClick={() => selectAgent(agent.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}
