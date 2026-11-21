import { isSameOriginRequest } from "../lib/request";
import {
  ContainerActionError,
  fetchContainers,
  filterContainers,
  runContainerAction,
  type ContainerAction,
} from "../services/docker";
import { crossOriginResponse } from "./responses";

export type ContainerFilter = "all" | "running" | "stopped";

export interface ContainerListQuery {
  filter: ContainerFilter;
  includeAllStates: boolean;
}

export function parseContainerListQuery(rawFilter: string | null): ContainerListQuery {
  const filter = rawFilter || "all";
  return {
    filter: filter as ContainerFilter,
    includeAllStates: filter === "all" || filter === "stopped",
  };
}

export function parseContainerAction(action: string): ContainerAction | undefined {
  return action === "start" || action === "stop" ? action : undefined;
}

export async function listContainers(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const { filter, includeAllStates } = parseContainerListQuery(url.searchParams.get("filter"));

    const containers = await fetchContainers(includeAllStates);
    const filteredContainers = filterContainers(containers, filter);

    return Response.json({
      containers: filteredContainers,
      count: filteredContainers.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching containers:", error);
    return Response.json(
      {
        error: "Failed to fetch containers",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export interface ContainerActionParams {
  id: string;
  action: string;
}

export async function postContainerAction(
  req: Request,
  params: ContainerActionParams,
): Promise<Response> {
  if (!isSameOriginRequest(req)) {
    return crossOriginResponse();
  }

  const action = parseContainerAction(params.action);
  if (!action) {
    return Response.json(
      {
        error: "Invalid container action",
        message: "Action must be start or stop",
      },
      { status: 400 },
    );
  }

  try {
    await runContainerAction(params.id, action);

    return Response.json({
      success: true,
      action,
      containerId: params.id,
      mock: process.env.USE_MOCK_DATA === "true",
    });
  } catch (error) {
    console.error(`Error running container action ${action}:`, error);

    const status = error instanceof ContainerActionError ? error.status : 500;
    return Response.json(
      {
        error: "Failed to run container action",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status },
    );
  }
}
