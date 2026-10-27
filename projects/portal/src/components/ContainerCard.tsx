// ContainerCard Component - 1 つのコンテナを「ポートの入口」として見せるカード / 行

import { useEffect, useRef, useState } from "react";
import type { Container, PortMapping } from "../types/container";
import { useConfig } from "../hooks/useConfig";
import { useCopy } from "../hooks/useCopy";
import { CopyButton, REVEAL_CARD } from "./CopyButton";
import { ConfirmPopover } from "./ConfirmPopover";
import { buildPortUrl, describePort } from "../lib/ports";
import {
  getContainerAction,
  getStatusTone,
  isPortReachable,
  type ContainerAction,
  type StatusTone,
} from "../lib/containerState";

export type { ContainerAction };

interface ContainerCardProps {
  container: Container;
  pendingAction?: ContainerAction | null;
  onAction?: (container: Container, action: ContainerAction) => void;
}

const TONE_DOT: Record<StatusTone, string> = {
  live: "bg-live",
  warn: "bg-warn",
  dead: "bg-dead",
  info: "bg-info",
  idle: "bg-fg-3",
};

const TONE_TEXT: Record<StatusTone, string> = {
  live: "text-live",
  warn: "text-warn",
  dead: "text-dead",
  info: "text-info",
  idle: "text-fg-3",
};

const TILE_BASE = "group/port flex rounded-lg border transition-colors duration-150";
const TILE_LIVE = "border-live/50 bg-ink-850 text-live hover:border-live/70 hover:bg-live/[0.09]";
const TILE_DORMANT = "border-line bg-ink-850 text-fg-3";

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0 transition-transform duration-150 group-hover/port:translate-x-0.5 group-hover/port:-translate-y-0.5"
    >
      <path d="M4.5 11.5 11.5 4.5" />
      <path d="M6 4.5h5.5V10" />
    </svg>
  );
}

/**
 * ステータス表示。色だけで意味を運ばないよう、必ず Docker の状態文言も添える。
 * "Up 3 days" のような人間向け文言を優先し、空のときだけ state に落とす。
 */
function StatusLabel({ container }: { container: Container }) {
  const tone = getStatusTone(container.state);
  const label = container.status || container.state;

  return (
    <p className="flex shrink-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap">
      <span
        aria-hidden="true"
        className={[
          "size-1.5 shrink-0 rounded-full",
          TONE_DOT[tone],
          isPortReachable(container.state) ? "motion-safe:animate-pulse" : "",
        ].join(" ")}
      />
      <span className={TONE_TEXT[tone]}>{label}</span>
    </p>
  );
}

/**
 * ポート 1 件。
 * 起動中のコンテナのポートだけをリンクにする。停止中のポートは docker 上に
 * 公開設定が残っていても接続できないため、押しても失敗するリンクを出さない
 * (点灯 = 押せる、の 1 対 1 対応を崩さない)。
 */
function PortLink({
  port,
  host,
  reachable,
  dense,
}: {
  port: PortMapping;
  host: string;
  reachable: boolean;
  dense: boolean;
}) {
  const detail = describePort(port);

  const className = [
    TILE_BASE,
    reachable ? TILE_LIVE : TILE_DORMANT,
    dense
      ? "h-9 flex-none items-center gap-1.5 px-2.5"
      : "flex-1 basis-[104px] flex-col justify-center px-3 py-2.5",
  ].join(" ");

  const content = (withArrow: boolean) =>
    dense ? (
      <>
        <span className="font-mono text-[15px] leading-none font-medium tabular-nums tracking-[-0.02em]">
          {port.publicPort}
        </span>
        <span
          className={[
            "font-mono text-[11px] leading-none tracking-[0.03em]",
            reachable ? "text-fg-2" : "text-fg-3",
          ].join(" ")}
        >
          {detail}
        </span>
        {withArrow && <ArrowIcon />}
      </>
    ) : (
      <>
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-[21px] leading-none font-medium tabular-nums tracking-[-0.02em]">
            {port.publicPort}
          </span>
          {withArrow && <ArrowIcon />}
        </span>
        <span
          className={[
            "mt-auto font-mono text-[11px] leading-none tracking-[0.03em]",
            reachable ? "text-fg-2" : "text-fg-3",
          ].join(" ")}
        >
          {detail}
        </span>
      </>
    );

  if (!reachable) {
    return (
      <span
        title={`${host}:${port.publicPort} is offline until the container starts`}
        className={className}
      >
        {content(false)}
      </span>
    );
  }

  const url = buildPortUrl(host, port.publicPort);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      aria-label={`Open ${host}:${port.publicPort} (container port ${port.privatePort}/${port.protocol})`}
      className={className}
    >
      {content(true)}
    </a>
  );
}

function PortLinks({
  ports,
  host,
  reachable,
  dense = false,
}: {
  ports: PortMapping[];
  host: string;
  reachable: boolean;
  dense?: boolean;
}) {
  if (ports.length === 0) {
    return <p className="text-[11.5px] text-fg-3">No published ports</p>;
  }

  return (
    <div className={dense ? "flex flex-wrap gap-1.5" : "flex flex-wrap gap-2"}>
      {ports.map((port, index) => (
        <PortLink
          key={`${port.publicPort}-${index}`}
          port={port}
          host={host}
          reachable={reachable}
          dense={dense}
        />
      ))}
    </div>
  );
}

/**
 * イメージ名とコピーボタン。
 * イメージ名は区切り文字のない長い文字列になり得るため、折り返さず省略する。
 * 折り返すとカードごとの高さが読めなくなり、ポートの位置が揃わなくなるため
 * (全文は title と、コピーボタンのクリップボードで拾える)。
 */
function ImageField({ image }: { image: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3" title={image}>
        {image}
      </p>
      <CopyButton
        copied={copied}
        onClick={() => void copy(image)}
        label="Copy image name"
        revealClass={REVEAL_CARD}
      />
    </div>
  );
}

function ActionButtonIcon({ action }: { action: ContainerAction }) {
  return action === "start" ? (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className="size-3">
      <path d="M5 3.2v9.6L13 8z" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className="size-3">
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
    </svg>
  );
}

/**
 * 起動 / 停止ボタン。停止だけは不可逆なので、押した場で確認ポップオーバーを出す。
 * window.confirm をやめた理由は、ダイアログが対象のコンテナから切り離されて
 * 「何を止めるのか」が読み返せないこと。
 */
function ContainerActionButton({
  action,
  container,
  pending,
  onAction,
}: {
  action: ContainerAction;
  container: Container;
  pending: boolean;
  onAction: (action: ContainerAction) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isStart = action === "start";

  // ポーリングでコンテナの状態が変わると action が入れ替わる。開いたままの確認が
  // 次に running へ戻ったとき勝手に開かないよう、action が変わったら閉じる。
  useEffect(() => {
    setConfirmOpen(false);
  }, [action]);

  const label = isStart ? "Start" : "Stop";
  const pendingLabel = isStart ? "Starting" : "Stopping";

  const handleClick = () => {
    if (isStart) {
      onAction("start");
      return;
    }
    setConfirmOpen((open) => !open);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        disabled={pending}
        aria-haspopup={isStart ? undefined : "dialog"}
        aria-expanded={isStart ? undefined : confirmOpen}
        onClick={handleClick}
        className={[
          "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line px-2.5",
          "text-[11.5px] font-medium transition-colors duration-150",
          "hover:border-line-strong hover:bg-ink-800",
          "disabled:cursor-not-allowed disabled:opacity-50",
          pending ? "text-fg-3" : isStart ? "text-fg-2 hover:text-fg" : "text-fg-2 hover:text-dead",
        ].join(" ")}
      >
        {pending ? (
          <span
            aria-hidden="true"
            className="size-3 animate-spin rounded-full border border-current border-t-transparent"
          />
        ) : (
          <ActionButtonIcon action={action} />
        )}
        <span>{pending ? pendingLabel : label}</span>
      </button>

      {/* 状態が変わって Start に切り替わったら、停止確認は残さない */}
      {!isStart && (
        <ConfirmPopover
          open={confirmOpen}
          anchorRef={anchorRef}
          title={`Stop ${container.name}?`}
          description="Its ports close immediately and open connections are dropped."
          confirmLabel="Stop"
          pending={pending}
          onConfirm={() => {
            setConfirmOpen(false);
            onAction("stop");
          }}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function ContainerActionSlot({ container, pendingAction, onAction }: ContainerCardProps) {
  const action = getContainerAction(container.state);

  if (!action || !onAction) {
    return null;
  }

  return (
    <ContainerActionButton
      action={action}
      container={container}
      pending={pendingAction === action}
      onAction={(next) => onAction(container, next)}
    />
  );
}

/**
 * コンテナカード。上部が個体の識別、中央がポート (この画面の主役)、下部が補助情報。
 */
export function ContainerCard({ container, pendingAction, onAction }: ContainerCardProps) {
  const { config } = useConfig();
  const host = config?.host || "localhost";
  const reachable = isPortReachable(container.state);

  return (
    <article
      className="group/card flex flex-col rounded-xl border border-line bg-ink-900
                 transition-colors duration-150 hover:border-line-strong"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <h3
          className="min-w-0 truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-fg"
          title={container.name}
        >
          {container.name}
        </h3>
        <StatusLabel container={container} />
      </div>

      <div className="flex-1 px-4 py-4">
        <PortLinks ports={container.ports} host={host} reachable={reachable} />
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <ImageField image={container.image} />
        </div>
        <ContainerActionSlot
          container={container}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      </div>
    </article>
  );
}

/**
 * コンテナリスト行。列幅を固定して、縦に並んだときポートの数字が揃うようにする。
 */
export function ContainerListItem({ container, pendingAction, onAction }: ContainerCardProps) {
  const { config } = useConfig();
  const host = config?.host || "localhost";
  const reachable = isPortReachable(container.state);

  return (
    <article
      className="group/card rounded-xl border border-line bg-ink-900 p-4
                 transition-colors duration-150 hover:border-line-strong
                 md:flex md:items-center md:gap-6 md:py-3"
    >
      <div className="min-w-0 md:w-[27%] md:shrink-0">
        <h3
          className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-fg"
          title={container.name}
        >
          {container.name}
        </h3>
        <div className="mt-1">
          <ImageField image={container.image} />
        </div>
      </div>

      <div className="mt-3 min-w-0 md:mt-0 md:flex-1">
        <PortLinks ports={container.ports} host={host} reachable={reachable} dense />
      </div>

      <div className="mt-3 flex items-center justify-between gap-4 md:mt-0 md:shrink-0 md:justify-end">
        <StatusLabel container={container} />
        <ContainerActionSlot
          container={container}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      </div>
    </article>
  );
}

export default ContainerCard;
