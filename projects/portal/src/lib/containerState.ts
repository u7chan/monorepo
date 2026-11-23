import { orderLinks } from "./ports";
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
 * リンクのタイルを 1 つでも出すコンテナか。判定条件は ContainerLinks の表示分岐と揃える
 * (ずれると「リンクが無いのに上に残る」カードが出る)。
 */
export function hasContainerLinks(container: Container): boolean {
  if (container.hidden) {
    return false;
  }

  if (container.url) {
    return true;
  }

  return orderLinks(container.ports, container.urls).length > 0;
}

/**
 * リンクを出すコンテナを先に並べる。開く先の無いカードは一覧の目的 (ポートを開く) に対して
 * ノイズになるため末尾へまとめる。並び替えのキーを状態にしないのは、30 秒ごとの更新で
 * 状態が変わるたびにカードの位置が動くと、押そうとしたカードを見失うため。
 * 同じ順位どうしは元の順 (docker ps の順) を保つ。
 */
export function sortContainersByLinks(containers: Container[]): Container[] {
  return [...containers].sort(
    (a, b) => Number(hasContainerLinks(b)) - Number(hasContainerLinks(a)),
  );
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
