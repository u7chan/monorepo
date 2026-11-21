// ContainerCard Component - 1 つのコンテナを「ポートの入口」として見せるカード / 行

import { Fragment, useEffect, useState } from "react";
import type { Container, PortMapping } from "../types/container";
import { useConfig } from "../hooks/useConfig";
import { useCopy } from "../hooks/useCopy";
import { useDeploy } from "../hooks/useDeploy";
import { Collapsible } from "./Collapsible";
import { ConfirmSheet } from "./ConfirmSheet";
import { CopyButton, REVEAL_CARD } from "./CopyButton";
import { DeployButton, DeployPanel } from "./DeployControl";
import { ArrowUpRightIcon, LockIcon, PlayIcon, StopIcon } from "./icons";
import { describeImage } from "../lib/image";
import { buildPortUrl, describePort, describeUrl, isHttpsUrl, orderLinks } from "../lib/ports";
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
  idle: "bg-label-3",
};

const TONE_TEXT: Record<StatusTone, string> = {
  live: "text-live",
  warn: "text-warn",
  dead: "text-dead",
  info: "text-info",
  idle: "text-label-2",
};

// 行の高さ・行送りは文字に任せる。固定の高さ + leading-none + truncate の組み合わせは、
// g や p の下端を切り落とす (以前の「見切れ」の原因) ため、タイルでは使わない。
const TILE_BASE =
  "group/port relative flex rounded-tile text-left transition-[background-color,scale] duration-150 ease-ios";
const TILE_LIVE =
  "bg-accent-wash text-accent active:scale-[0.98] can-hover:hover:bg-accent-wash-strong";
const TILE_DORMANT = "bg-fill text-label-2";

const TILE_ARROW =
  "size-[18px] shrink-0 transition-transform duration-150 can-hover:group-hover/port:translate-x-0.5 can-hover:group-hover/port:-translate-y-0.5";

/**
 * ステータス表示。色だけで意味を運ばないよう、必ず Docker の状態文言も添える。
 * "Up 3 days" のような人間向け文言を優先し、空のときだけ state に落とす。
 */
function StatusLabel({ container }: { container: Container }) {
  const tone = getStatusTone(container.state);
  const label = container.status || container.state;

  return (
    <p className="mt-0.5 flex items-start gap-1.5 text-subhead">
      <span
        aria-hidden="true"
        className={["mt-[0.4375rem] size-2 shrink-0 rounded-full", TONE_DOT[tone]].join(" ")}
      />
      <span className={["min-w-0 [overflow-wrap:anywhere]", TONE_TEXT[tone]].join(" ")}>
        {label}
      </span>
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
      ? "min-h-10 items-center gap-2 rounded-full px-4 py-2"
      : "min-h-[72px] flex-col justify-between gap-1 px-4 py-3",
  ].join(" ");

  const content = (withArrow: boolean) =>
    dense ? (
      <>
        <span className="font-mono text-callout font-medium tabular-nums">{port.publicPort}</span>
        <span className="font-mono text-caption text-label-2">{detail}</span>
        {withArrow && <ArrowUpRightIcon className={TILE_ARROW} />}
      </>
    ) : (
      <>
        <span className="flex items-start justify-between gap-2">
          <span className="font-mono text-title-2 font-medium tabular-nums">{port.publicPort}</span>
          {withArrow && <ArrowUpRightIcon className={`mt-0.5 ${TILE_ARROW}`} />}
        </span>
        <span className="font-mono text-caption text-label-2">{detail}</span>
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
      aria-label={`Open ${url} (container port ${port.privatePort}/${port.protocol})`}
      className={className}
    >
      {content(true)}
    </a>
  );
}

/**
 * ホスト名。ピリオドの直後で折り返せるようにして、狭いときも "preview.agent." / "home.arpa"
 * のように意味の切れ目で改行する。単語の途中で切るのは、どこにも切れ目が無いときだけにする。
 */
function HostLabel({ label }: { label: string }) {
  const parts = label.split(".");

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * ラベルで指定された URL のタイル。
 * SSL 化済みのアプリはポート番号を出さず、行き先のホスト名と鍵アイコンで表す
 * (ポート番号は行き先を表さないし、TLS 終端の有無を推測させないため)。
 * ホスト名は省略せず折り返す。サブドメインの違いが読めなくなるため。
 */
function UrlLink({ url, reachable, dense }: { url: string; reachable: boolean; dense: boolean }) {
  const label = describeUrl(url);
  const secure = isHttpsUrl(url);
  const scheme = secure ? "https" : "http";

  const className = [
    TILE_BASE,
    reachable ? TILE_LIVE : TILE_DORMANT,
    dense
      ? "min-h-10 max-w-full items-center gap-2 rounded-full px-4 py-2"
      : "col-span-full min-h-[72px] items-center gap-3 px-4 py-3",
  ].join(" ");

  const content = (withArrow: boolean) =>
    dense ? (
      <>
        {secure && <LockIcon className="size-[18px] shrink-0" />}
        <span className="min-w-0 font-mono text-callout font-medium [overflow-wrap:anywhere]">
          <HostLabel label={label} />
        </span>
        {withArrow && <ArrowUpRightIcon className={TILE_ARROW} />}
      </>
    ) : (
      <>
        {secure && <LockIcon className="size-5 shrink-0" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-callout font-semibold [overflow-wrap:anywhere]">
            <HostLabel label={label} />
          </span>
          <span className="font-mono text-caption text-label-2">{scheme}</span>
        </span>
        {withArrow && <ArrowUpRightIcon className={TILE_ARROW} />}
      </>
    );

  if (!reachable) {
    return (
      <span title={`${url} is offline until the container starts`} className={className}>
        {content(false)}
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      aria-label={`Open ${url}`}
      className={className}
    >
      {content(true)}
    </a>
  );
}

/**
 * リンク群。公開の有無によらずポート番号の昇順に並べる。
 * - `portal.hidden` はリンクを出さない (Caddy などの入口そのもの)
 * - `portal.url` は 1 本だけ出す (公開ポートの数を見せない)
 * - `portal.url.<ポート>` は該当ポートのタイルを URL に差し替える。publish をやめても
 *   キーは識別子として残るため、公開されていないポートの上書きもタイルにする
 */
function ContainerLinks({
  container,
  host,
  dense = false,
}: {
  container: Container;
  host: string;
  dense?: boolean;
}) {
  const reachable = isPortReachable(container.state);
  const wrapper = dense
    ? "flex flex-wrap gap-2"
    : "grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2";

  if (container.hidden) {
    return <p className="text-subhead text-label-2">Links hidden</p>;
  }

  if (container.url) {
    return (
      <div className={wrapper}>
        <UrlLink url={container.url} reachable={reachable} dense={dense} />
      </div>
    );
  }

  const links = orderLinks(container.ports, container.urls);

  if (links.length === 0) {
    return <p className="text-subhead text-label-2">No published ports</p>;
  }

  return (
    <div className={wrapper}>
      {links.map(({ portNumber, url, port }, index) =>
        url ? (
          <UrlLink
            key={`url-${portNumber}-${index}`}
            url={url}
            reachable={reachable}
            dense={dense}
          />
        ) : port ? (
          <PortLink
            key={`port-${portNumber}-${index}`}
            port={port}
            host={host}
            reachable={reachable}
            dense={dense}
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * イメージ名とコピーボタン。
 * 長い名前は 1 行に収め、レジストリや名前空間から先に省略する。折り返すとカードごとの
 * 高さが読めなくなり、末尾から切ると「どのタグか」が消える。全文は title とコピーで拾える。
 */
function ImageField({ image }: { image: string }) {
  const { copied, copy } = useCopy();
  const { prefix, name, version } = describeImage(image);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <p className="flex min-w-0 font-mono text-footnote text-label-2" title={image}>
        <span className="min-w-0 truncate">{prefix}</span>
        <span className="max-w-full shrink-0 truncate">
          {name}
          {version}
        </span>
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

/**
 * 起動 / 停止ボタン。停止だけは不可逆なので、押したところで確認シートを出す。
 * window.confirm をやめた理由は、ダイアログが対象のコンテナから切り離されて
 * 「何を止めるのか」が読み返せないこと。シートのタイトルに対象の名前を入れて示す。
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
    setConfirmOpen(true);
  };

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-haspopup={isStart ? undefined : "dialog"}
        onClick={handleClick}
        className={[
          "hit-area inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-fill px-4",
          "text-subhead font-semibold transition-[background-color,scale] duration-150 ease-ios",
          "can-hover:hover:bg-fill-strong active:scale-[0.97] active:bg-fill-strong",
          "disabled:cursor-not-allowed disabled:opacity-60",
          pending ? "text-label-2" : "text-label",
        ].join(" ")}
      >
        {pending ? (
          <span
            aria-hidden="true"
            className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : isStart ? (
          <PlayIcon className="size-3.5" />
        ) : (
          <StopIcon className="size-3.5" />
        )}
        <span>{pending ? pendingLabel : label}</span>
      </button>

      {/* 状態が変わって Start に切り替わったら、停止確認は残さない */}
      {!isStart && (
        <ConfirmSheet
          open={confirmOpen}
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
    </>
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
 * 名前と状態。名前は省略せず折り返す。長い名前を 1 行に押し込むと、末尾の違い
 * (-production と -staging など) が読めなくなる。
 */
function ContainerHeading({ container }: { container: Container }) {
  return (
    <div className="min-w-0 flex-1 basis-[9rem]">
      <h3
        className="text-headline font-semibold [overflow-wrap:anywhere] text-label"
        title={container.name}
      >
        {container.name}
      </h3>
      <StatusLabel container={container} />
    </div>
  );
}

/**
 * コンテナカード。上部が個体の識別と起動 / 停止、中央がポート (この画面の主役)、下部が補助情報。
 */
export function ContainerCard({ container, pendingAction, onAction }: ContainerCardProps) {
  const { config } = useConfig();
  const host = config?.host || "localhost";
  const deploy = useDeploy(container);

  return (
    <article className="group/card flex flex-col rounded-card bg-surface shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4">
        <ContainerHeading container={container} />
        <ContainerActionSlot
          container={container}
          pendingAction={pendingAction}
          onAction={onAction}
        />
      </div>

      <div className="px-4 pt-3 pb-4">
        <ContainerLinks container={container} host={host} />
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-separator px-4 py-1.5">
        <div className="min-w-0 flex-1 basis-[11rem]">
          <ImageField image={container.image} />
        </div>
        {container.canDeploy && <DeployButton deploy={deploy} />}
      </div>

      {container.canDeploy && (
        <Collapsible open={deploy.isOpen}>
          <div className="border-t border-separator px-4 py-3">
            <DeployPanel deploy={deploy} />
          </div>
        </Collapsible>
      )}
    </article>
  );
}

/**
 * コンテナリスト行。1 つの面にまとめた行で、広い画面ではポートの位置が縦に揃うよう列を固定する。
 * 配置は index.css の .list-row が持つ (DOM の順序は、名前 → リンク → イメージ → 操作)。
 */
export function ContainerListItem({ container, pendingAction, onAction }: ContainerCardProps) {
  const { config } = useConfig();
  const host = config?.host || "localhost";
  const deploy = useDeploy(container);

  return (
    <article className="group/card px-4 py-3">
      <div className="list-row" data-can-deploy={container.canDeploy || undefined}>
        <div className="[grid-area:title]">
          <ContainerHeading container={container} />
        </div>
        <div className="min-w-0 [grid-area:links]">
          <ContainerLinks container={container} host={host} dense />
        </div>
        <div className="min-w-0 [grid-area:image]">
          <ImageField image={container.image} />
        </div>
        {container.canDeploy && (
          <div className="[grid-area:deploy]">
            <DeployButton deploy={deploy} />
          </div>
        )}
        <div className="justify-self-end [grid-area:stop]">
          <ContainerActionSlot
            container={container}
            pendingAction={pendingAction}
            onAction={onAction}
          />
        </div>
      </div>

      {container.canDeploy && (
        <Collapsible open={deploy.isOpen}>
          <div className="mt-3 border-t border-separator pt-3">
            <DeployPanel deploy={deploy} />
          </div>
        </Collapsible>
      )}
    </article>
  );
}

export default ContainerCard;
