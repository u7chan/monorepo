#!/usr/bin/env node
/**
 * 開発用の一括起動: サンドボックス・BFF・Vite を別プロセスで立てる。
 * 共有トークンは起動ごとに生成し、サンドボックスと BFF にだけ渡す (手動 export も .env の設定も不要)。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 作業領域。BFF とサンドボックスで同じパスを使う (パス解決を一致させる) */
const APP_CWD = resolve(process.env.PI_APP_CWD || ROOT);
const SANDBOX_PORT = Number(process.env.SANDBOX_PORT) || 8080;
const BFF_PORT = Number(process.env.PORT) || 4317;
const TOKEN = randomBytes(24).toString("base64url");
const children = [];
let viteUrl = null;
let stopping = false;

const log = (message) => process.stdout.write(`[dev] ${message}\n`);

/** 使用中ポートは起動途中の EADDRINUSE より先に、原因の分かる形で止める */
function assertPortFree(port) {
  return new Promise((ok, ng) => {
    const probe = createServer();
    probe.once("error", () =>
      ng(new Error(`ポート ${port} は使用中です。pnpm dev の二重起動か、別のプロセスを停止してください。`)),
    );
    probe.once("listening", () => probe.close(ok));
    probe.listen(port, "127.0.0.1");
  });
}

/** 子プロセスの出力へ名前を付ける (3 プロセスのログが混ざっても出所を追えるように) */
function prefix(label, stream, onLine) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    // 停止中の pnpm の ELIFECYCLE などは出さない
    if (stopping) return;
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${label} | ${line}\n`);
      onLine?.(line);
    }
  });
}

function start(label, script, env, onLine) {
  const child = spawn("pnpm", [script], {
    cwd: ROOT,
    // 独立したプロセスグループにして、停止時に配下 (tsx / vite / 実行中のツール) までまとめて止める
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefix(label.padEnd(7), child.stdout, onLine);
  prefix(label.padEnd(7), child.stderr, onLine);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    log(`${label} が終了しました (${signal ?? code})。残りも停止します`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

async function waitUntilReady(url, child, what) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${what} が起動前に終了しました`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 起動途中は接続拒否になる
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`${what} が応答しません (${url})`);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  log("停止しています");
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      // すでに終了している
    }
  }
  // 子の終了処理 (サンドボックスは実行中のツールを中断する) を待つ。残っていれば強制終了する
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    const alive = children.some((child) => child.exitCode === null && child.signalCode === null);
    if (alive && Date.now() < deadline) return;
    clearInterval(timer);
    if (alive) {
      for (const child of children) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // すでに終了している
        }
      }
    }
    log("停止しました");
    process.exit(code);
  }, 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  await assertPortFree(SANDBOX_PORT);
  await assertPortFree(BFF_PORT);

  log(`作業領域: ${APP_CWD}`);
  if (process.env.PI_SANDBOX_CWD) {
    log(`PI_SANDBOX_CWD は使わず、BFF と同じ ${APP_CWD} をサンドボックスへ渡します`);
  }
  log(`サンドボックスを起動します (http://127.0.0.1:${SANDBOX_PORT})`);
  const sandbox = start("sandbox", "start:sandbox", {
    SANDBOX_HOST: "127.0.0.1",
    SANDBOX_PORT: String(SANDBOX_PORT),
    PI_SANDBOX_TOKEN: TOKEN,
    // BFF と別のディレクトリを使うと表示と実際のツール実行場所がずれるため、一括起動では常に揃える
    PI_SANDBOX_CWD: APP_CWD,
  });
  await waitUntilReady(`http://127.0.0.1:${SANDBOX_PORT}/healthz`, sandbox, "サンドボックス");

  log(`BFF を起動します (http://127.0.0.1:${BFF_PORT})`);
  const bff = start("bff", "dev:bff", {
    PORT: String(BFF_PORT),
    PI_APP_CWD: APP_CWD,
    PI_SANDBOX_URL: `http://127.0.0.1:${SANDBOX_PORT}`,
    PI_SANDBOX_TOKEN: TOKEN,
  });
  await waitUntilReady(`http://127.0.0.1:${BFF_PORT}/api/health`, bff, "BFF");

  log("Vite を起動します");
  // Dev サーバーへ共有トークンは渡さない (BFF 経由でしか使わない)
  const viteEnv = { ...process.env };
  delete viteEnv.PI_SANDBOX_TOKEN;
  start("vite", "dev:web", viteEnv, (line) => {
    const found = line.match(/https?:\/\/localhost:\d+\//);
    if (found && !viteUrl) viteUrl = found[0];
  });

  const deadline = Date.now() + 30_000;
  while (!viteUrl && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
  log(viteUrl ? `準備完了: ${viteUrl} を開いてください` : `準備完了: Vite の URL を取得できませんでした`);
  log("停止するときは Ctrl-C (3 プロセスまとめて止まります)");
}

try {
  await main();
} catch (error) {
  log(error.message);
  shutdown(1);
}
