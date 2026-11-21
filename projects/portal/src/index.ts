import { serve } from "bun";
import index from "./index.html";
import { apiRoutes } from "./api/routes";
import { isMockMode } from "./services/mockData";
import { staticRoutes } from "./static";

// モックモード表示
if (isMockMode()) {
  console.log("🎭 MOCK MODE ENABLED - Using mock container data");
}

const server = serve({
  routes: {
    ...staticRoutes,

    // Serve index.html for all unmatched routes.
    "/*": index,

    ...apiRoutes,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
