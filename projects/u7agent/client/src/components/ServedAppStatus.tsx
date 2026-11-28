import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { usePopoverShell, type PopoverPlaceInput } from "../hooks/usePopoverShell";
import { cn } from "../lib/cn";
import { rowMenuPlacement, ROW_MENU_MARGIN, type RowMenuDescriptionKind } from "../lib/rowMenu";
import type { ServeTunnelEntry } from "../lib/serveTunnel";
import {
  openServedApp,
  servedAppMenuSeparators,
  servedAppMenuSub,
  servedAppReplaceHint,
  servedAppUrl,
  servedAppView,
  type ServeRowState,
  type ServeView,
} from "../lib/servedApp";
import type { ServeStatus } from "../types";
import { MenuItem } from "./MenuItem";
import { ExternalLinkIcon, PowerIcon, QrCodeIcon, RunSpinnerIcon, ShareIcon, StopIcon } from "./icons";

export type ServedAppProps = {
  /** health の previewPort (ブラウザから見たポート)。serviceOrigin も無ければリンクを出さない */
  port?: number;
  /** health の serviceOrigin (ブラウザから見たサービス オリジン)。設定済みならポートより優先する */
  serviceOrigin?: string;
  /** 閲覧中の会話から見た状態。未取得 (初回 / 会話切替直後 / 取得失敗) は undefined */
  status?: ServeStatus | null;
  /** 一時共有。全会話で 1 本の全体の状態で、サービスの状態や取得の失敗とは独立に出す */
  tunnel: ServeTunnelEntry;
  /** 取得に失敗した。リンクも操作も出さない (到達不可と区別する) */
  failed: boolean;
  /** 起動の確認待ち (期限つきプローブが終わるまでの遷移状態) */
  starting: boolean;
  /** 直前の操作の失敗理由 */
  error?: string;
  /** 起動の後にバー直下へ出す「開く」1 行のエピソード (desktop は出さない) */
  row: ServeRowState;
  /** 行の「開く」。開いてから行を消す (順序は hook が決める) */
  onOpenRow: (url: string) => void;
  /** 行の ✕。このエピソードだけを閉じる */
  onDismissRow: () => void;
  /** desktop の「サービス」リンクへ焦点を移す 1 ショット要求 (このタブの起動が成功したときだけ立つ) */
  focusRequest?: boolean;
  onFocusHandled?: () => void;
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
  ok: "serve-tone-ok",
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
 * 一時共有の表示と操作。共有中は「共有中・残り N 分」(押すとダイアログ) と停止を、サービスの状態に関係なく
 * 出す。共有中でなければ、この会話が起動したアプリ (`canShare`) のときだけ始める入口を出す。
 */
function ServeShareControls({ canShare, tunnel }: { canShare: boolean; tunnel: ServeTunnelEntry }) {
  const { view } = tunnel;
  if (view.sharing) {
    return (
      <>
        <button
          type="button"
          onClick={tunnel.onOpen}
          aria-haspopup="dialog"
          title="QR・URL・残り時間を開きます"
          className="btn-quiet shrink-0 border-accent/50 text-accent-text"
        >
          {view.phase === "starting" ? <RunSpinnerIcon /> : <ShareIcon />}
          {view.badge}
        </button>
        <button
          type="button"
          onClick={tunnel.onStop}
          disabled={tunnel.stopping}
          title={view.phase === "starting" ? "共有の準備を中断します" : "共有を止めて URL を無効にします"}
          className="btn-quiet shrink-0 border-danger/45 text-danger-text"
        >
          <StopIcon />
          {view.stopLabel}
        </button>
      </>
    );
  }
  if (!canShare) return null;
  const unavailable = view.phase === "unavailable";
  return (
    <button
      type="button"
      onClick={tunnel.onOpen}
      disabled={unavailable}
      aria-haspopup="dialog"
      aria-label={unavailable ? "一時共有（利用できません）" : "一時共有を開始"}
      title={
        unavailable ? (view.unavailableReason ?? "一時共有を使えません") : "このサービスを期限つきの URL で共有します"
      }
      className="icon-button shrink-0"
    >
      <ShareIcon />
    </button>
  );
}

/**
 * desktop のサービスのグループ。[状態バッジ] [サービス] [停止/起動] [共有] ｜ を 1 つの単位にして、
 * 右寄せクラスタの左端に置く (出ても通知・作業フォルダの位置が動かない)。区切り線も一緒に出し入れする。
 */
export function ServedAppGroup({
  port,
  serviceOrigin,
  status,
  failed,
  starting,
  tunnel,
  focusRequest,
  onFocusHandled,
  onStart,
  onStop,
  onCancel,
}: ServedAppProps) {
  const view = servedAppView(status);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  // リンクを描かない早期 return の後ろには置けない (描かないときも要求を消費する必要がある)。
  // 消費しないと、レイアウトを desktop へ切り替えたときに古い要求で焦点が飛ぶ
  useEffect(() => {
    if (!focusRequest) return;
    onFocusHandled?.();
    linkRef.current?.focus();
  }, [focusRequest, onFocusHandled]);
  const serviceStarting = !failed && starting;
  const serviceShown = !failed && !starting && view.kind !== "none";
  // 共有中の表示と停止は、サービスが止まっても・状態を取得できなくても消さない (消し忘れを防ぐ)
  if (!serviceStarting && !serviceShown && !tunnel.view.sharing) return null;
  const href = serviceShown && view.canOpen ? servedAppUrl(location.hostname, port, serviceOrigin) : undefined;
  return (
    <span className="inline-flex items-center gap-2">
      {serviceStarting ? (
        <>
          <StartingBadge />
          <button type="button" onClick={onCancel} title="起動の確認をやめます" className="btn-quiet shrink-0">
            キャンセル
          </button>
        </>
      ) : null}
      {serviceShown ? (
        <>
          <ServeBadge view={view} />
          {href ? (
            <a
              ref={linkRef}
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
        </>
      ) : null}
      <ServeShareControls canShare={serviceShown && view.canShare} tunnel={tunnel} />
      <ServeSeparator />
    </span>
  );
}

/** グループと通知の間の区切り。グループと一緒に出し入れする */
function ServeSeparator() {
  return <i aria-hidden="true" className="block h-5.5 w-px shrink-0 bg-line" />;
}

/** singleColumn は幅を増やさないため、停止中の起動も状態メニューも同じ 1 枠に収める。 */
export function ServedAppIndicator({
  port,
  serviceOrigin,
  status,
  failed,
  starting,
  tunnel,
  onStart,
  onStop,
  onCancel,
}: ServedAppProps) {
  const view = servedAppView(status);
  const share = tunnel.view;
  const serviceShown = !failed && (starting || view.kind !== "none");
  const menuId = useId();
  const triggerId = `${menuId}-trigger`;

  // cwd とコマンドは長さが決まらないため、`w-max` のままだと menu が画面より広くなり、右端の項目と
  // command が切れる。幅 / 高さの上限は hook が margin から書くので、ここは left / top だけを返す
  const placeMenu = useCallback(({ popover, trigger, viewport }: PopoverPlaceInput) => {
    if (trigger === null) return null;
    return rowMenuPlacement(trigger.getBoundingClientRect(), popover.getBoundingClientRect(), viewport);
  }, []);

  // スクロール / resize の再配置と focus 退出での終了は持たない (開いている間の再配置は hook が
  // commit ごとに行い、閉じる経路は項目の選択と [起動をキャンセル] だけ)
  const { triggerProps, popoverProps, itemRef, close } = usePopoverShell(placeMenu, ROW_MENU_MARGIN);

  // 起動の確認待ちが終わったらメニューを閉じる (古い状態のメニューを残さない)。close は identity が
  // 固定なので、依存は starting だけで足りる (毎描画で閉じると、開いた直後に消える)
  useLayoutEffect(() => {
    if (starting) return;
    close();
  }, [close, starting]);

  // 共有中の表示と停止は、サービスが止まっても・状態を取得できなくても消さない (消し忘れを防ぐ)
  if (!serviceShown && !share.sharing) return null;
  if (!starting && serviceShown && !share.sharing && view.kind === "stopped") {
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

  const tone = starting || share.sharing ? "serve-icon-accent" : ICON_TONE[view.tone];
  const href = serviceShown && view.canOpen ? servedAppUrl(location.hostname, port, serviceOrigin) : undefined;
  const shareUnavailable = share.phase === "unavailable";
  type MenuEntry = {
    key: string;
    icon: ReactNode;
    label: string;
    description?: string;
    descriptionKind?: RowMenuDescriptionKind;
    danger?: boolean;
    disabled?: boolean;
    run: () => void;
  };
  const serviceItems: MenuEntry[] = !serviceShown
    ? []
    : starting
      ? [
          {
            key: "cancel",
            icon: <RunSpinnerIcon />,
            label: "起動をキャンセル",
            description: "8080 に到達できるかを確認しています",
            descriptionKind: "note" as const,
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
                  // 何を止めるのかは実行前に効く (置き換えの可否が変わる)
                  descriptionKind: "disclosure" as const,
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
                  descriptionKind: "disclosure" as const,
                  run: onStart,
                },
              ]
            : []),
        ];
  const shareItems: MenuEntry[] = share.sharing
    ? [
        {
          key: "share-open",
          icon: <QrCodeIcon />,
          label: "共有の画面を開く",
          description: "QR・URL・残り時間",
          descriptionKind: "disclosure" as const,
          run: tunnel.onOpen,
        },
        {
          key: "share-stop",
          icon: <StopIcon />,
          label: share.stopLabel,
          descriptionKind: "disclosure" as const,
          danger: true,
          disabled: tunnel.stopping,
          run: tunnel.onStop,
        },
      ]
    : serviceShown && view.canShare
      ? [
          {
            key: "share",
            icon: <ShareIcon />,
            label: "一時共有…",
            description: shareUnavailable
              ? (share.unavailableReason ?? "一時共有を使えません")
              : "期限つきの URL で外へ共有",
            descriptionKind: "disclosure" as const,
            disabled: shareUnavailable,
            run: tunnel.onOpen,
          },
        ]
      : [];
  const items = [...serviceItems, ...shareItems];
  const separators = servedAppMenuSeparators(items);
  const mark = share.sharing ? (
    share.phase === "starting" ? (
      <RunSpinnerIcon />
    ) : (
      <ShareIcon />
    )
  ) : starting ? (
    <RunSpinnerIcon />
  ) : (
    <ServeMark view={view} />
  );

  return (
    <>
      <button
        type="button"
        {...triggerProps}
        id={triggerId}
        aria-haspopup="menu"
        aria-label={
          share.sharing
            ? `${share.badge}。メニューを開く`
            : starting
              ? "サービスは起動中。メニューを開く"
              : view.ariaLabel
        }
        popoverTarget={menuId}
        popoverTargetAction="toggle"
        className={cn("icon-button shrink-0", tone)}
      >
        {mark}
      </button>
      <div
        {...popoverProps}
        id={menuId}
        popover="auto"
        role="menu"
        aria-labelledby={triggerId}
        className="popover-panel fixed inset-auto m-0 w-max min-w-52 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-panel singleColumn:min-w-56 singleColumn:p-2"
      >
        <div className="grid gap-1 px-2 pt-1.5 pb-2">
          {serviceShown ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-1xs text-ink">
                {starting ? <RunSpinnerIcon /> : <ServeMark view={view} />}
                {starting ? "起動中…" : view.label}
              </span>
              {/* cwd · コマンドは桁数が決まらないため折り返す (1 行に固定すると cwd だけで埋まり、command の頭だけになる) */}
              <span className="text-2xs break-words text-ink-muted singleColumn:text-1xs">
                {starting ? "8080 に到達できるかを確認しています" : servedAppMenuSub(view)}
              </span>
            </>
          ) : null}
          {share.sharing ? (
            <span className="inline-flex items-center gap-1.5 text-1xs text-ink">
              {share.phase === "starting" ? <RunSpinnerIcon /> : <ShareIcon />}
              {share.badge}
            </span>
          ) : null}
        </div>
        <div aria-hidden="true" className="mx-1 mb-1 h-px bg-line" />
        {items.map((item, index) => (
          <Fragment key={item.key}>
            {/* 通常の操作と危険な操作の間に区切りを入れる (並びは変えない。⋯ メニューと同じ見た目) */}
            {separators[index] ? <div aria-hidden="true" className="mx-1 my-1 h-px bg-line" /> : null}
            <MenuItem
              ref={itemRef(index)}
              role="menuitem"
              tabIndex={-1}
              icon={item.icon}
              label={item.label}
              description={item.description}
              descriptionKind={item.descriptionKind ?? "disclosure"}
              danger={item.danger}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.run();
              }}
            />
          </Fragment>
        ))}
      </div>
    </>
  );
}
