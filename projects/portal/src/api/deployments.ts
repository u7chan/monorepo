import { isDeployableImageTag, monorepoProject, parseImageReference } from "../lib/image";
import { isJsonRequest, isSameOriginRequest } from "../lib/request";
import { fetchContainers } from "../services/docker";
import { DEPLOY_WORKFLOW_URL, dispatchDeploy, listImageTags } from "../services/github";
import { isMockMode, mockImageTags } from "../services/mockData";
import type { Container } from "../types/container";
import { crossOriginResponse, deployErrorResponse } from "./responses";

export type DeployTargetLookup =
  | { kind: "not-found" }
  | { kind: "container-not-deployable" }
  | { kind: "project-not-deployable" }
  | { kind: "ready"; container: Container; deployTarget: string; project: string };

export function findDeployTarget(
  containers: readonly Container[],
  containerId: string,
): DeployTargetLookup {
  const container = containers.find((c) => c.id === containerId);

  if (!container) {
    return { kind: "not-found" };
  }
  if (!container.canDeploy || !container.deployTarget) {
    return { kind: "container-not-deployable" };
  }

  const project = monorepoProject(container.image);
  if (!project) {
    return { kind: "project-not-deployable" };
  }

  return { kind: "ready", container, deployTarget: container.deployTarget, project };
}

async function lookupDeployTarget(containerId: string): Promise<DeployTargetLookup> {
  return findDeployTarget(await fetchContainers(true), containerId);
}

export interface DeployOptionsParams {
  id: string;
}

export async function getDeployOptions(
  _req: Request,
  params: DeployOptionsParams,
): Promise<Response> {
  try {
    const lookup = await lookupDeployTarget(params.id);

    if (lookup.kind === "not-found") {
      return Response.json({ error: "Container not found" }, { status: 404 });
    }
    if (lookup.kind === "container-not-deployable") {
      return Response.json(
        { error: "Image switching is not available for this container" },
        { status: 409 },
      );
    }
    if (lookup.kind === "project-not-deployable") {
      return Response.json(
        { error: "Image switching is not available for this image" },
        { status: 409 },
      );
    }

    const currentTag = parseImageReference(lookup.container.image).tag ?? null;

    if (isMockMode()) {
      return Response.json({
        target: lookup.deployTarget,
        currentTag,
        tags: mockImageTags,
      });
    }

    return Response.json({
      target: lookup.deployTarget,
      currentTag,
      tags: await listImageTags(lookup.project),
    });
  } catch (error) {
    return deployErrorResponse(error);
  }
}

export interface DeploymentRequest {
  containerId: string;
  tag: string;
}

export type DeploymentRequestParseResult =
  | { ok: true; request: DeploymentRequest }
  | { ok: false; error: string };

export function parseDeploymentRequest(body: unknown): DeploymentRequestParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Invalid request body" };
  }

  const { containerId, tag } = body as Record<string, unknown>;
  if (typeof containerId !== "string" || typeof tag !== "string") {
    return { ok: false, error: "containerId and tag are required" };
  }
  if (!isDeployableImageTag(tag)) {
    return { ok: false, error: "Invalid image tag" };
  }

  return { ok: true, request: { containerId, tag } };
}

export async function postDeployment(req: Request): Promise<Response> {
  if (!isSameOriginRequest(req)) {
    return crossOriginResponse();
  }
  if (!isJsonRequest(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseDeploymentRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const { containerId, tag } = parsed.request;

  try {
    const lookup = await lookupDeployTarget(containerId);

    if (lookup.kind === "not-found") {
      return Response.json({ error: "Container not found" }, { status: 404 });
    }
    if (lookup.kind !== "ready") {
      return Response.json(
        { error: "Image switching is not available for this container" },
        { status: 409 },
      );
    }

    if (isMockMode()) {
      return Response.json(
        {
          target: lookup.deployTarget,
          tag,
          workflowUrl: DEPLOY_WORKFLOW_URL,
        },
        { status: 202 },
      );
    }

    const workflowUrl = await dispatchDeploy(lookup.deployTarget, tag);
    return Response.json({ target: lookup.deployTarget, tag, workflowUrl }, { status: 202 });
  } catch (error) {
    return deployErrorResponse(error);
  }
}
