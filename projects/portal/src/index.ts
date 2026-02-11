import { serve } from "bun";
import index from "./index.html";
import { fetchContainers, filterContainers } from "./services/docker";

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
          const filter =
            (url.searchParams.get("filter") as "all" | "running" | "stopped") ||
            "all";
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

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/config": {
      GET(req) {
        return Response.json({
          isMockMode: process.env.USE_MOCK_DATA === "true",
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
