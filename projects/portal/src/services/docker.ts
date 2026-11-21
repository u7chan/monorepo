// Docker CLIサービス - Bun.$ を使用してdockerコマンドを実行

import type { ContainerAction } from "../lib/containerState";
import type { Container } from "../types/container";
import { excludePortalContainers, parseContainerList } from "./dockerParser";
import { mockContainers, isMockMode } from "./mockData";

export type { ContainerAction };

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
