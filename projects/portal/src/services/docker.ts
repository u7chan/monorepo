// Docker CLIサービス - Bun.$ を使用してdockerコマンドを実行

import type { Container, PortMapping, DockerContainerRaw } from "../types/container";
import { mockContainers, isMockMode } from "./mockData";

export type ContainerAction = "start" | "stop";

export class ContainerActionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ContainerActionError";
  }
}

/**
 * ポート文字列をパースする
 * "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp" のような形式を解析
 */
export function parsePorts(portsStr: string): PortMapping[] {
  if (!portsStr || portsStr.trim() === "") {
    return [];
  }

  const ports: PortMapping[] = [];
  const seen = new Set<string>(); // 重複チェック用
  const portEntries = portsStr.split(", ");

  for (const entry of portEntries) {
    // 形式: 0.0.0.0:3000->80/tcp または :::3000->80/tcp または [::]:3000->80/tcp
    const match = entry.match(/^(.*?):(\d+)->(\d+)\/(tcp|udp|sctp)$/);

    if (match) {
      const [, host, publicPort, privatePort, protocol] = match;
      if (!publicPort || !privatePort || !protocol) {
        continue;
      }
      const key = `${publicPort}->${privatePort}/${protocol}`;

      // 同じpublicPort->privatePort/protocolの組み合わせが既に存在する場合はスキップ（IPv4/IPv6重複排除）
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      ports.push({
        host: host || "0.0.0.0",
        publicPort: parseInt(publicPort, 10),
        privatePort: parseInt(privatePort, 10),
        protocol: protocol,
      });
    }
  }

  return ports;
}

/**
 * コンテナ名から先頭のスラッシュを除去
 */
export function normalizeName(name: string): string {
  return name.replace(/^\//, "");
}

// ポートリンクの URL をサービス側から上書きするためのラベル接頭辞。
// ホスト名とポートだけでは HTTPS かどうかを判断できないため、TLS 終端の有無を
// portal の推測に頼らず compose 定義側で表明できるようにする。
const URL_LABEL_PREFIX = "portal.url.";

/**
 * `portal.url.<公開ポート>=<URL>` 形式のラベルを公開ポート -> URL に変換する
 */
export function parseUrlLabels(labels: string | undefined): Record<number, string> | undefined {
  if (!labels) return undefined;

  const urls: Record<number, string> = {};
  for (const pair of labels.split(",")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;

    const key = pair.slice(0, index).trim();
    if (!key.startsWith(URL_LABEL_PREFIX)) continue;

    const portText = key.slice(URL_LABEL_PREFIX.length);
    if (!/^\d+$/.test(portText)) continue;

    const port = Number(portText);
    const value = pair.slice(index + 1).trim();
    if (port >= 1 && port <= 65535 && value) urls[port] = value;
  }

  return Object.keys(urls).length > 0 ? urls : undefined;
}

// portal 自身を表すイメージリポジトリ。タグやダイジェストは含めない。
const PORTAL_IMAGE_REPOSITORY = "ghcr.io/u7chan/monorepo/portal";

// docker はコンテナの HOSTNAME に短縮コンテナ ID（12 桁の hex）を入れる。
// ホスト上で bun dev しているときの HOSTNAME はマシン名なので、その形のときだけ自己判定に使う。
const CONTAINER_ID_HOSTNAME = /^[0-9a-f]{12}$/i;

/**
 * イメージ参照からタグとダイジェストを落としてリポジトリだけにする
 */
function imageRepository(image: string): string {
  const withoutDigest = image.split("@")[0] ?? "";
  const tagIndex = withoutDigest.lastIndexOf(":");
  const slashIndex = withoutDigest.lastIndexOf("/");
  return tagIndex > slashIndex ? withoutDigest.slice(0, tagIndex) : withoutDigest;
}

/**
 * portal 自身のコンテナかどうか
 *
 * Why not: ラベル（`com.docker.compose.service` など）で判定しないのは、deploy 側の
 * compose 定義を portal の都合に合わせたくないため。イメージ名と HOSTNAME だけで判定する。
 */
export function isPortalContainer(
  container: Container,
  hostname: string = process.env.HOSTNAME ?? "",
): boolean {
  if (imageRepository(container.image) === PORTAL_IMAGE_REPOSITORY) {
    return true;
  }

  return CONTAINER_ID_HOSTNAME.test(hostname) && container.id.startsWith(hostname);
}

/**
 * portal 自身を一覧から除く
 */
export function excludePortalContainers(
  containers: Container[],
  hostname: string = process.env.HOSTNAME ?? "",
): Container[] {
  return containers.filter((container) => !isPortalContainer(container, hostname));
}

/**
 * Dockerの生データをContainer型に変換
 */
export function parseContainer(raw: DockerContainerRaw): Container {
  const id = raw.ID || raw.Id || "";
  const name = raw.Names ? normalizeName(raw.Names) : "";
  const image = raw.Image || "";
  const state = (raw.State || "unknown") as Container["state"];
  const status = raw.Status || "";
  const ports = parsePorts(raw.Ports || "");
  const created = raw.CreatedAt || "";
  const command = raw.Command || "";
  const urls = parseUrlLabels(raw.Labels);

  return {
    id,
    name,
    image,
    state,
    status,
    ports,
    created,
    command,
    urls,
  };
}

/**
 * docker ps の JSON Lines 出力を Container に変換し、portal 自身を除く
 */
export function parseContainerList(
  output: string,
  hostname: string = process.env.HOSTNAME ?? "",
): Container[] {
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

  const containers: Container[] = [];

  for (const line of lines) {
    try {
      containers.push(parseContainer(JSON.parse(line) as DockerContainerRaw));
    } catch (parseError) {
      console.error("Failed to parse container JSON:", line, parseError);
    }
  }

  return excludePortalContainers(containers, hostname);
}

/**
 * Dockerコンテナ一覧を取得
 */
export async function fetchContainers(all: boolean = false): Promise<Container[]> {
  // モックモード時はモックデータを返す
  if (isMockMode()) {
    console.log("[MOCK MODE] Returning mock container data");
    // 大量データテストが必要な場合はこちら
    // return generateManyContainers(20);
    return excludePortalContainers(mockContainers);
  }

  try {
    // Bun.$ を使って docker ps コマンドを実行
    const cmd = all ? "docker ps --all --format json" : "docker ps --format json";

    const result = await Bun.$`${cmd.split(" ")}`;

    return parseContainerList(result.text());
  } catch (error) {
    console.error("Failed to fetch containers:", error);
    throw new Error(
      `Docker command failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * コンテナ操作の実行前チェック
 */
export async function validateContainerAction(
  containerId: string,
  action: ContainerAction,
): Promise<Container> {
  const containers = await fetchContainers(true);
  const container = containers.find((c) => c.id === containerId);

  if (!container) {
    throw new ContainerActionError(`Container not found: ${containerId}`, 404);
  }

  if (action === "start" && container.state !== "exited") {
    throw new ContainerActionError(`Container must be exited to start: ${container.name}`, 409);
  }

  if (action === "stop" && container.state !== "running") {
    throw new ContainerActionError(`Container must be running to stop: ${container.name}`, 409);
  }

  return container;
}

/**
 * Dockerコンテナを起動/停止
 */
export async function runContainerAction(
  containerId: string,
  action: ContainerAction,
): Promise<void> {
  await validateContainerAction(containerId, action);

  if (isMockMode()) {
    console.log(`[MOCK MODE] ${action} container: ${containerId}`);
    return;
  }

  try {
    if (action === "start") {
      await Bun.$`docker start ${containerId}`;
      return;
    }

    await Bun.$`docker stop ${containerId}`;
  } catch (error) {
    console.error(`Failed to ${action} container:`, error);
    throw new Error(
      `Docker ${action} failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * コンテナをフィルタリング
 */
export function filterContainers(
  containers: Container[],
  filter: "all" | "running" | "stopped",
): Container[] {
  switch (filter) {
    case "running":
      return containers.filter((c) => c.state === "running");
    case "stopped":
      return containers.filter((c) => c.state === "exited" || c.state === "dead");
    case "all":
    default:
      return containers;
  }
}
