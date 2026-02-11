// Docker CLIサービス - Bun.$ を使用してdockerコマンドを実行

import type {
  Container,
  PortMapping,
  DockerContainerRaw,
} from "../types/container";

/**
 * ポート文字列をパースする
 * "0.0.0.0:3000->80/tcp, 0.0.0.0:4000->443/tcp" のような形式を解析
 */
export function parsePorts(portsStr: string): PortMapping[] {
  if (!portsStr || portsStr.trim() === "") {
    return [];
  }

  const ports: PortMapping[] = [];
  const portEntries = portsStr.split(", ");

  for (const entry of portEntries) {
    // 形式: 0.0.0.0:3000->80/tcp または :::3000->80/tcp
    const match = entry.match(
      /^(.*?):(\d+)->(\d+)\/(tcp|udp|sctp)$/,
    );

    if (match) {
      const [, host, publicPort, privatePort, protocol] = match;
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

  return {
    id,
    name,
    image,
    state,
    status,
    ports,
    created,
    command,
  };
}

/**
 * Dockerコンテナ一覧を取得
 */
export async function fetchContainers(
  all: boolean = false,
): Promise<Container[]> {
  try {
    // Bun.$ を使って docker ps コマンドを実行
    const cmd = all
      ? "docker ps --all --format json"
      : "docker ps --format json";

    const result = await Bun.$`${cmd.split(" ")}`;
    const output = await result.text();

    // JSON Lines形式で複数行のJSONが返ってくる場合がある
    const lines = output.trim().split("\n").filter((line) => line.length > 0);

    if (lines.length === 0) {
      return [];
    }

    const containers: Container[] = [];

    for (const line of lines) {
      try {
        const raw: DockerContainerRaw = JSON.parse(line);
        containers.push(parseContainer(raw));
      } catch (parseError) {
        console.error("Failed to parse container JSON:", line, parseError);
      }
    }

    return containers;
  } catch (error) {
    console.error("Failed to fetch containers:", error);
    throw new Error(
      `Docker command failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
      return containers.filter(
        (c) => c.state === "exited" || c.state === "dead",
      );
    case "all":
    default:
      return containers;
  }
}
