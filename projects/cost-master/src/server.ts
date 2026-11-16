import index from "../index.html";
import { createApp } from "./server/app";
import { loadConfig } from "./server/config";
import { loadMaster } from "./server/master-file";

const config = loadConfig(process.env);
const loaded = loadMaster(
  new URL("./server/data/prices.json", import.meta.url),
  new URL("./server/data/enabled.json", import.meta.url),
);
const app = createApp({ master: () => loaded.state });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.development,
  routes: { "/": index },
  fetch: (request) => app.fetch(request),
});

console.log(`cost-master を起動しました: http://${config.host}:${server.port}`);

if (loaded.state.ok) {
  console.log(
    `master: version ${loaded.state.payload.version} / ${loaded.state.payload.models.length} 行 / fetchedAt ${new Date(loaded.state.payload.fetchedAt).toISOString()}`,
  );
} else {
  console.error(`master を読めませんでした: ${loaded.reason ?? "unknown"}（/api/models は 503 を返します）`);
}

for (const dropped of loaded.dropped) {
  console.warn(`master の行を落としました: ${dropped.modelId || "(no modelId)"} (${dropped.reason})`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
