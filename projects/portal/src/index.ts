import { serve } from "bun";
import index from "./index.html";
import { staticRoutes } from "./static";
import { apiRoutes } from "./api/routes";

// モックモード表示
const isMockMode = process.env.USE_MOCK_DATA === "true";
if (isMockMode) {
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
