import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { nextRowMenuIndex, rowMenuPlacement, ROW_MENU_MARGIN } from "../lib/rowMenu";
import {
  openServedApp,
  servedAppMenuSub,
  servedAppReplaceHint,
  servedAppUrl,
  servedAppView,
  type ServeView,
} from "../lib/servedApp";
import type { ServeStatus } from "../types";
import { MenuItem } from "./MenuItem";
import { ExternalLinkIcon, PowerIcon, RunSpinnerIcon, StopIcon } from "./icons";

export type ServedAppProps = {
  /** health の previewPort (ブラウザから見たポート)。未取得ならリンクを出さない */
  port?: number;
  /** 閲覧中の会話から見た状態。未取得 (初回 / 会話切替直後 / 取得失敗) は undefined */
  status?: ServeStatus | null;
  /** 取得に失敗した。リンクも操作も出さない (到達不可と区別する) */
  failed: boolean;
  /** 起動の確認待ち (期限つきプローブが終わるまでの遷移状態) */
  starting: boolean;
  /** 直前の操作の失敗理由 */
  error?: string;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
};

/** 状態の形 (色だけに頼らない)。稼働中 = 緑の塗りドット / 停止中 = 灰の薄いドット / 起動元不明 = ! / 起動中 = スピナー */
function ServeMark({ view }: { view: ServeView }) {
  if (view.kind === "unknown") return <span className="text-xs leading-none font-bold">!</span>;
  return <span className={cn("dot", view.tone === "ok" ? "dot-ok" : view.tone === "warn" ? "dot-warn" : "dot-idle")} />;
}

const BADGE_TONE: Record<ServeView["tone"], string> = {
  ok: "serve-badge-ok",
  idle: "",
  warn: "serve-badge-warn",
};

const ICON_TONE: Record<ServeView["tone"], string> = {
  ok: "serve-icon-ok",
  idle: "serve-icon-idle",
  warn: "serve-icon-warn",
};

/** 非対話の状態バッジ。状態と操作を混ぜない (操作は隣のボタン) */
function ServeBadge({ view }: { view: ServeView }) {
  return (
    <span title={view.badgeTitle} className={cn("serve-badge", BADGE_TONE[view.tone])}>
      <ServeMark view={view} />
      {view.label}
    </span>
  );
}

function StartingBadge() {
  return (
    <span aria-live="polite" className="serve-badge serve-badge-accent">
      <RunSpinnerIcon />
      起動中…
    </span>
  );
}

/**
 * desktop のサービスのグループ。[状態バッジ] [サービス] [停止/起動] ｜ を 1 つの単位にして、
 * 右寄せクラスタの左端に置く (出ても通知・作業フォルダの位置が動かない)。区切り線も一緒に出し入れする。
 */
export function ServedAppGroup({ port, status, failed, starting, onStart, onStop, onCancel }: ServedAppProps) {
  const view = servedAppView(status);
  if (!failed && starting) {
    return (
      <span className="inline-flex items-center gap-2">
        <StartingBadge />
        <button type="button" onClick={onCancel} title="起動の確認をやめます" className="btn-quiet shrink-0">
          キャンセル
        </button>
        <ServeSeparator />
      </span>
    );
  }
  if (failed || view.kind === "none") return null;
  const href = view.canOpen ? servedAppUrl(location.hostname, port) : undefined;
  return (
    <span className="inline-flex items-center gap-2">
      <ServeBadge view={view} />
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="サービスを開く"
          title="この会話のサービスを別タブで開きます"
          className="btn-quiet shrink-0"
        >
          <ExternalLinkIcon />
          サービス
        </a>
      ) : null}
      {view.canStop ? (
        <button
          type="button"
          onClick={onStop}
          title={view.kind === "unknown" ? "いま公開中のプロセスを停止します" : "この会話のサービスを停止します"}
          className={cn("btn-quiet shrink-0", "border-danger/45 text-danger-text")}
        >
          <StopIcon />
          停止
        </button>
      ) : null}
      {view.canStart ? (
        <button type="button" onClick={onStart} title={servedAppReplaceHint(view)} className="btn-quiet shrink-0">
          <PowerIcon />
          起動
        </button>
      ) : null}
      <ServeSeparator />
    </span>
  );
}

/** グループと通知の間の区切り。グループと一緒に出し入れする */
function ServeSeparator() {
  return <i aria-hidden="true" className="block h-5.5 w-px shrink-0 bg-line" />;
}

/** compact は幅を増やさないため、停止中の起動も状態メニューも同じ 1 枠に収める。 */
export function ServedAppIndicator({ port, status, failed, starting, onStart, onStop, onCancel }: ServedAppProps) {
  const view = servedAppView(status);
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const place = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover === null || trigger === null) return;
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    // 幅も viewport の内側に収める。cwd とコマンドは長さが決まらないため、`w-max` のままだと menu が
    // 画面より広くなり、右端の項目と command が切れる。測る前に書いて、位置と大きさを同じ測定で決める
    popover.style.maxWidth = `${Math.max(0, viewport.width - ROW_MENU_MARGIN * 2)}px`;
    // 折り返した行数も決まらないため、高さも同じく viewport に収める (あふれは menu 内のスクロールへ逃がす)
    popover.style.maxHeight = `${Math.max(0, viewport.height - ROW_MENU_MARGIN * 2)}px`;
    const { left, top } = rowMenuPlacement(trigger.getBoundingClientRect(), popover.getBoundingClientRect(), viewport);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }, []);

  // 開いている間は commit のたびに置き直す (幅の変化やレイアウト切替に追随する)
  useLayoutEffect(() => {
    if (open) place();
  });

  const onToggle = useCallback((event: Event) => {
    setOpen((event as ToggleEvent).newState === "open");
  }, []);

  /**
   * 開閉の正は popover の状態 (Escape / 外側クリックの light dismiss もここで観測する)。
   * status の取得前は popover 自体を描画しないため、Effect ではなく ref の付け外しで購読を更新する
   * (依存配列が空の Effect だと、初回取得後に mount した popover を購読できない)。
   */
  const attachPopover = useCallback(
    (element: HTMLDivElement | null) => {
      const previous = popoverRef.current;
      if (previous) previous.removeEventListener("toggle", onToggle);
      popoverRef.current = element;
      if (element === null) return;
      element.addEventListener("toggle", onToggle);
      setOpen(element.matches(":popover-open"));
    },
    [onToggle],
  );

  // 起動の確認待ちが終わったらメニューを閉じる (古い状態のメニューを残さない)
  useLayoutEffect(() => {
    if (starting) return;
    popoverRef.current?.hidePopover();
  }, [starting]);

  if (failed || (!starting && view.kind === "none")) return null;
  if (!starting && view.kind === "stopped") {
    return (
      <button
        type="button"
        onClick={onStart}
        aria-label={view.ariaLabel}
        title={servedAppReplaceHint(view)}
        className="icon-button shrink-0"
      >
        <PowerIcon />
      </button>
    );
  }

  const tone = starting ? "serve-icon-accent" : ICON_TONE[view.tone];
  const toggle = () => {
    const popover = popoverRef.current;
    if (popover === null) return;
    if (popover.matches(":popover-open")) popover.hidePopover();
    else {
      popover.showPopover();
      place();
      itemsRef.current[0]?.focus();
    }
  };
  const close = () => popoverRef.current?.hidePopover();
  // 矢印キーは RowMenu と同じ規則で項目のフォーカスを移す (tabIndex=-1 の項目を Tab でたどらせない)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 止めないと App の Escape (設定ページからチャットへ戻る) まで届く。閉じるのは標準挙動に任せる
      event.stopPropagation();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const current = items.findIndex((item) => item === document.activeElement);
    items[nextRowMenuIndex(current, items.length, event.key === "ArrowDown" ? "next" : "previous")]?.focus();
  };
  const href = view.canOpen ? servedAppUrl(location.hostname, port) : undefined;
  const items: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    description?: string;
    danger?: boolean;
    run: () => void;
  }> = starting
    ? [
        {
          key: "cancel",
          icon: <RunSpinnerIcon />,
          label: "起動をキャンセル",
          description: "8080 に到達できるかを確認しています",
          run: onCancel,
        },
      ]
    : [
        ...(href
          ? [
              {
                key: "open",
                icon: <ExternalLinkIcon />,
                label: "サービスを開く",
                run: () => openServedApp(href),
              },
            ]
          : []),
        ...(view.canStop
          ? [
              {
                key: "stop",
                icon: <StopIcon />,
                label: "停止",
                description: view.kind === "unknown" ? "いま公開中のプロセスを停止" : undefined,
                danger: true,
                run: onStop,
              },
            ]
          : []),
        ...(view.canStart
          ? [
              {
                key: "start",
                icon: <PowerIcon />,
                label: "起動",
                description: servedAppReplaceHint(view),
                run: onStart,
              },
            ]
          : []),
      ];

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        id={triggerId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={starting ? "サービスは起動中。メニューを開く" : view.ariaLabel}
        popoverTarget={menuId}
        popoverTargetAction="toggle"
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
        className={cn("icon-button shrink-0", tone)}
      >
        {starting ? <RunSpinnerIcon /> : <ServeMark view={view} />}
      </button>
      <div
        ref={attachPopover}
        id={menuId}
        popover="auto"
        role="menu"
        aria-labelledby={triggerId}
        onKeyDown={onKeyDown}
        className="popover-panel fixed inset-auto m-0 w-max min-w-52 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-panel"
      >
        <div className="grid gap-1 px-2 pt-1.5 pb-2">
          <span className="inline-flex items-center gap-1.5 text-1xs text-ink">
            {starting ? <RunSpinnerIcon /> : <ServeMark view={view} />}
            {starting ? "起動中…" : view.label}
          </span>
          {/* cwd · コマンドは桁数が決まらないため折り返す (1 行に固定すると cwd だけで埋まり、command の頭だけになる) */}
          <span className="text-2xs break-words text-ink-muted">
            {starting ? "8080 に到達できるかを確認しています" : servedAppMenuSub(view)}
          </span>
        </div>
        <div aria-hidden="true" className="mx-1 mb-1 h-px bg-line" />
        {items.map((item, index) => (
          <MenuItem
            key={item.key}
            ref={(element) => {
              itemsRef.current[index] = element;
            }}
            role="menuitem"
            tabIndex={-1}
            icon={item.icon}
            label={item.label}
            description={item.description}
            danger={item.danger}
            onClick={() => {
              close();
              item.run();
            }}
          />
        ))}
      </div>
    </>
  );
}
