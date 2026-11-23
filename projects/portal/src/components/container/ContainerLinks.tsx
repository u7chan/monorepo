import { Fragment } from "react";
import { isPortReachable } from "../../lib/containerState";
import { buildPortUrl, describePort, describeUrl, isHttpsUrl, orderLinks } from "../../lib/ports";
import type { Container, PortMapping } from "../../types/container";
import { ArrowUpRightIcon, LockIcon } from "../icons";

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
export function HostLabel({ label }: { label: string }) {
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
 * タイルを 1 つも出さないコンテナは一覧の末尾に送られる (lib/containerState.ts の
 * hasContainerLinks)。分岐を変えるときは両方を揃える。
 * - `portal.hidden` はリンクを出さない (Caddy などの入口そのもの)
 * - `portal.url` は 1 本だけ出す (公開ポートの数を見せない)
 * - `portal.url.<ポート>` は該当ポートのタイルを URL に差し替える。publish をやめても
 *   キーは識別子として残るため、公開されていないポートの上書きもタイルにする
 */
export function ContainerLinks({
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
