import index from "../index.html";
import { createApp } from "./server/app";
import { loadConfig } from "./server/config";
import { createMasterStore } from "./server/master-store";
import { MASTER_KINDS } from "./shared/contract";

const config = loadConfig(process.env);
const store = createMasterStore({
  dir: config.masterDir,
  bundledDir: new URL("./server/data/", import.meta.url).pathname,
  log: (line) => console.log(`[cost-master] ${line}`),
});

try {
  store.ensureSeed();
} catch {
  // volume を用意できなくても起動は続ける。読めなければ /api/models が 503 を返し、health で分かる
  console.error("[cost-master] マスタの置き場を用意できませんでした");
}

const app = createApp({ master: () => store.state(), store });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.development,
  routes: { "/": index },
  fetch: (request) => app.fetch(request),
});

const state = store.state();

console.log(`cost-master を起動しました: http://${config.host}:${server.port}`);
console.log(`マスタ: ${config.masterDir}`);

if (state.ok) {
  console.log(
    `version ${state.payload.version} / ${state.payload.models.length} 行 / fetchedAt ${new Date(state.payload.fetchedAt).toISOString()}`,
  );
} else {
  console.error("マスタを読めませんでした（/api/models は 503 を返します）");
}

for (const kind of MASTER_KINDS) {
  if (store.raw(kind) === null) {
    console.warn(`マスタのファイルがありません: ${kind}.json`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
