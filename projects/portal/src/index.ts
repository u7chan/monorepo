import { serve } from "bun";
import index from "./index.html";
import { staticRoutes } from "./static";
import {
  ContainerActionError,
  fetchContainers,
  filterContainers,
  runContainerAction,
  type ContainerAction,
} from "./services/docker";
import { isValidImageTag, monorepoProject, parseImageReference } from "./lib/image";
import { isJsonRequest, isSameOriginRequest } from "./lib/request";
import {
  DEPLOY_WORKFLOW_URL,
  GithubServiceError,
  dispatchDeploy,
  listImageTags,
} from "./services/github";
import { mockImageTags } from "./services/mockData";

// モックモード表示
const isMockMode = process.env.USE_MOCK_DATA === "true";
if (isMockMode) {
  console.log("🎭 MOCK MODE ENABLED - Using mock container data");
}

function deployErrorResponse(error: unknown): Response {
  if (error instanceof GithubServiceError) {
    return Response.json(
      { error: "Deploy request failed", message: error.message },
      { status: error.status },
    );
  }

  console.error("Deploy request failed:", error);
  return Response.json(
    { error: "Deploy request failed", message: "Unexpected error" },
    { status: 500 },
  );
}

function crossOriginResponse(): Response {
  return Response.json({ error: "Cross-origin request is not allowed" }, { status: 403 });
}

const server = serve({
  routes: {
    ...staticRoutes,

    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/containers": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const filter = (url.searchParams.get("filter") as "all" | "running" | "stopped") || "all";
          const all = filter === "all" || filter === "stopped";

          const containers = await fetchContainers(all);
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
      },
    },

    "/api/containers/:id/:action": {
      async POST(req) {
        if (!isSameOriginRequest(req)) {
          return crossOriginResponse();
        }

        const { id, action } = req.params;

        if (action !== "start" && action !== "stop") {
          return Response.json(
            {
              error: "Invalid container action",
              message: "Action must be start or stop",
            },
            { status: 400 },
          );
        }

        try {
          await runContainerAction(id, action as ContainerAction);

          return Response.json({
            success: true,
            action,
            containerId: id,
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
      },
    },

    "/api/containers/:id/deploy-options": {
      async GET(req) {
        try {
          const containers = await fetchContainers(true);
          const container = containers.find((c) => c.id === req.params.id);

          if (!container) {
            return Response.json({ error: "Container not found" }, { status: 404 });
          }
          if (!container.canDeploy || !container.deployTarget) {
            return Response.json(
              { error: "Image switching is not available for this container" },
              { status: 409 },
            );
          }

          const project = monorepoProject(container.image);
          if (!project) {
            return Response.json(
              { error: "Image switching is not available for this image" },
              { status: 409 },
            );
          }

          const currentTag = parseImageReference(container.image).tag ?? null;

          if (isMockMode) {
            return Response.json({
              target: container.deployTarget,
              currentTag,
              tags: mockImageTags,
            });
          }

          return Response.json({
            target: container.deployTarget,
            currentTag,
            tags: await listImageTags(project),
          });
        } catch (error) {
          return deployErrorResponse(error);
        }
      },
    },

    "/api/deployments": {
      async POST(req) {
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

        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "Invalid request body" }, { status: 400 });
        }

        const { containerId, tag } = body as Record<string, unknown>;
        if (typeof containerId !== "string" || typeof tag !== "string") {
          return Response.json({ error: "containerId and tag are required" }, { status: 400 });
        }
        if (!isValidImageTag(tag)) {
          return Response.json({ error: "Invalid image tag" }, { status: 400 });
        }

        try {
          const containers = await fetchContainers(true);
          const container = containers.find((c) => c.id === containerId);

          if (!container) {
            return Response.json({ error: "Container not found" }, { status: 404 });
          }
          if (
            !container.canDeploy ||
            !container.deployTarget ||
            !monorepoProject(container.image)
          ) {
            return Response.json(
              { error: "Image switching is not available for this container" },
              { status: 409 },
            );
          }

          if (isMockMode) {
            return Response.json(
              {
                target: container.deployTarget,
                tag,
                workflowUrl: DEPLOY_WORKFLOW_URL,
              },
              { status: 202 },
            );
          }

          const workflowUrl = await dispatchDeploy(container.deployTarget, tag);
          return Response.json(
            { target: container.deployTarget, tag, workflowUrl },
            { status: 202 },
          );
        } catch (error) {
          return deployErrorResponse(error);
        }
      },
    },

    "/api/hello": {
      async GET(_req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(_req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/config": {
      GET(_req) {
        return Response.json({
          isMockMode: process.env.USE_MOCK_DATA === "true",
          host: process.env.PORTAL_HOST || "localhost",
        });
      },
    },

    "/api/hello/:name": async (req) => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
