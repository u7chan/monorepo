import { createApp, PORT } from "./app";

Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: createApp().fetch });
console.log(`Open http://localhost:${PORT}/`);
