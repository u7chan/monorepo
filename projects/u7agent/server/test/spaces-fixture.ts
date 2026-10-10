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
    // live 行の枠・ホールド・畳みの受入用: 速い順次 + 並列の連続ツール呼び出し (本文に「連続ツール」で発動)
    toolBurst: [
      {
        prompt: "連続ツール",
        calls: [
          { name: "read", args: { path: "client/src/lib/liveToolCall.ts" }, at: 0, endAt: 120 },
          { name: "bash", args: { command: "pnpm -C client test:unit" }, at: 220, endAt: 400 },
          { name: "read", args: { path: "docs/frontend.md" }, at: 480, endAt: 620 },
          { name: "edit", args: { path: "client/src/components/Composer.tsx" }, at: 700, endAt: 900 },
          { name: "bash", args: { command: "git diff --stat" }, at: 980, endAt: 1080 },
          // 並列 (同じ時刻に始まる) の 2 件
          { name: "grep", args: { command: "grep -rn chat-live-reserve client/src" }, at: 1060, endAt: 1240 },
          { name: "read", args: { path: "client/src/styles/index.css" }, at: 1060, endAt: 1300 },
          { name: "bash", args: { command: "pnpm check" }, at: 1400, endAt: 1900 },
        ],
      },
      // 畳みはじめの窓に極端に短命な行が来る再現 (本文に「畳み窓」で発動)。
      // 1 本目が終わるとホールドが切れて箱が畳みはじめ、その 100ms 後に start と end が同じ時刻の行が
      // 届く。畳みはじめを解除しないとこの行は 900ms のホールドごと消える (docs/testing.md の受入項目)
      {
        prompt: "畳み窓",
        calls: [{ name: "bash", args: { command: "sleep 1" }, at: 0, endAt: 900 }],
        closingWindow: { afterMs: 100, name: "bash", args: { command: "echo in-closing-window" } },
      },
    ],
    // 自動 (preflight) 圧縮の受入用: 本文に「自動圧縮」を含めて送ると、user message を積む前に
    // 1 回だけ圧縮が走る (区切りとターン終端の両方が出る)
    preflightCompaction: { prompt: "自動圧縮", compaction: { reason: "threshold" } },
    // 手動圧縮の受入用: 1 回目は成功、2 回目は失敗 (too-small で区切りも所要時間も出ない)。
    // 3 回目以降は manualCompaction (未指定 = 成功) に戻る
    manualCompactions: [{ reason: "manual" }, { reason: "manual", failure: "too-small" }],
  }),
  { cwd, sandboxConfigured: true },
);
// workspace を渡すと env 由来のサンドボックスは作られないため、引っ越しの物理移動は別の口として渡す
// (渡さないと受入の「⋯ から別のスペースへ引っ越す」が必ず 503 になる)
const bff = await createBffApp({
  cwd,
  sessionStoreDir: store,
  workspace,
  moveSandbox: workspace,
  pi: asPiBff(pi),
});
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
