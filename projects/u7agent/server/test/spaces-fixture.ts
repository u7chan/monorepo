import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createBffApp } from "../src/app";
import { createSandboxToolClientFromEnv } from "../src/sandbox/client";
import { asPiBff, createStubPi } from "./stub-pi";

const root = process.env.U7AGENT_FIXTURE_ROOT;
if (!root?.startsWith("/tmp/u7agent-spaces-e2e-") || root.includes("..")) {
  throw new Error("U7AGENT_FIXTURE_ROOT は mktemp で作成した /tmp/u7agent-spaces-e2e-* を指定してください");
}
const cwd = join(root, "workspace");
const store = join(root, "store");
await mkdir(store, { recursive: true });
const workspace = createSandboxToolClientFromEnv(process.env);
if (!workspace) throw new Error("別プロセスの一時サンドボックス URL / token が必要です");
const pi = Object.assign(
  createStubPi({
    chunkDelayMs: 150,
    // live 行の受入用: 実モデルの代わりに investigate の呼び出しと進捗を流す
    investigateProgress: {
      prompt: "リポジトリの docs 構成を調べ、investigate の記述箇所を報告して",
      progress: [
        "grep -rn investigate docs/",
        "grep -rn investigate docs/\nREADME.md と subagent.md に記述があります",
        "grep -rn investigate docs/\nREADME.md と subagent.md に記述があります\n結論: 索引は docs/README.md、契約は docs/subagent.md にあります",
      ],
      result: "結論: 索引は docs/README.md、契約は docs/subagent.md にあります",
    },
  }),
  { cwd, sandboxConfigured: true },
);
const bff = await createBffApp({ cwd, sessionStoreDir: store, workspace, pi: asPiBff(pi) });
if (bff.projects.list().length === 0) {
  await workspace.createDir("normal-project");
  bff.projects.create({ cwd: "normal-project", name: "通常のプロジェクト" });
}
if (bff.store.list("default").length === 0) {
  const session = await bff.store.create({});
  await bff.store.setTitle(session.id, "通常の会話");
}
const server = serve({ fetch: bff.app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT) || 17990 });
console.log(`[spaces fixture] stub pi / store: ${store} / workspace: ${cwd}`);
const shutdown = async () => {
  server.close();
  await bff.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
