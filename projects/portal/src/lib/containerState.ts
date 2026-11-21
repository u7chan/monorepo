import type { Container, ContainerFilter } from "../types/container";

export type ContainerAction = "start" | "stop";

export type StatusTone = "live" | "warn" | "dead" | "info" | "idle";

export function matchesContainerFilter(container: Container, filter: ContainerFilter): boolean {
  switch (filter) {
    case "running":
      return container.state === "running";
    case "stopped":
      return container.state === "exited" || container.state === "dead";
    case "all":
    default:
      return true;
  }
}

/**
 * コンテナをフィルタリング
 */
export function filterContainers(containers: Container[], filter: ContainerFilter): Container[] {
  return containers.filter((container) => matchesContainerFilter(container, filter));
}

/**
 * ポートが今この瞬間に応答する見込みがあるか。
 * 表示色の意味を 1 つに保つため、ポートタイルの点灯はこの判定だけに従わせる。
 */
export function isPortReachable(state: Container["state"]): boolean {
  return state === "running";
}

/**
 * その状態で押せる操作。running は stop、exited は start、それ以外は操作しない。
 * サーバー側の validateContainerAction と同じ前提 (paused / restarting は対象外)。
 */
export function getContainerAction(state: Container["state"]): ContainerAction | null {
  if (state === "running") {
    return "stop";
  }

  if (state === "exited") {
    return "start";
  }

  return null;
}

export function getStatusTone(state: Container["state"]): StatusTone {
  switch (state) {
    case "running":
      return "live";
    case "exited":
    case "dead":
      return "dead";
    case "paused":
      return "warn";
    case "restarting":
      return "info";
    default:
      return "idle";
  }
}
