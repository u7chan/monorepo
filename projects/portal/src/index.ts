import { serve } from "bun";
import index from "./index.html";
import {
  ContainerActionError,
  fetchContainers,
  filterContainers,
  runContainerAction,
  type ContainerAction,
} from "./services/docker";

// モックモード表示
const isMockMode = process.env.USE_MOCK_DATA === "true";
if (isMockMode) {
  console.log("🎭 MOCK MODE ENABLED - Using mock container data");
}

const server = serve({
  routes: {
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
