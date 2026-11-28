import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const BINARY = fileURLToPath(new URL("../tools/cloudflared", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function mask(text) {
  return String(text)
    .replace(/[a-z0-9-]+\.trycloudflare\.com/gi, "<random>.trycloudflare.com")
    .replace(/\b(?!127\.)(?!0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>")
    .replace(/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, "<ipv6>")
    .replace(/\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?\b/gi, "<ipv6>");
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function tunnelArgs({ originPort, metricsPort }) {
  return [
    "tunnel",
    "--no-autoupdate",
    "--config",
    "/dev/null",
    "--metrics",
    `127.0.0.1:${metricsPort}`,
    "--grace-period",
    "5s",
    "--url",
    `http://127.0.0.1:${originPort}`,
  ];
}

async function httpGet(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch {
    // メトリクスのリスナーが上がる前は接続を拒否される
    return { status: 0, body: "", headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitUntilReady({
  metricsPort,
  startedAt,
  lines = [],
  isAlive = () => true,
  timeoutMs = 90000,
}) {
  const samples = [];
  let hostname;
  let url;
  let hostnameAt;
  let firstReadyAt;
  while (performance.now() - startedAt < timeoutMs) {
    if (!isAlive()) break;
    const quick = await httpGet(`http://127.0.0.1:${metricsPort}/quicktunnel`);
    const ready = await httpGet(`http://127.0.0.1:${metricsPort}/ready`);
    samples.push({ at: Math.round(performance.now() - startedAt), ready: ready.status, quick: quick.status });
    if (ready.status === 200 && firstReadyAt === undefined) firstReadyAt = performance.now() - startedAt;
    if (quick.status === 200) {
      try {
        const quicktunnel = JSON.parse(quick.body);
        if (!hostname && typeof quicktunnel.hostname === "string") {
          hostname = quicktunnel.hostname.replace(/^https?:\/\//, "");
          url = `https://${hostname}`;
          hostnameAt = performance.now() - startedAt;
        }
      } catch {
        // URL が出る前は空・HTML のことがある
      }
    }
    if (hostname && ready.status === 200) {
      return {
        url,
        hostname,
        hostnameAt: Math.round(hostnameAt),
        readyAt: Math.round(performance.now() - startedAt),
        firstReadyAt: firstReadyAt === undefined ? null : Math.round(firstReadyAt),
        samples,
      };
    }
    await sleep(200);
  }
  const error = lines
    .filter((line) => /ERR|failed|error/i.test(line))
    .slice(-5)
    .join("\n");
  throw new Error(`tunnel did not become ready within ${timeoutMs}ms (alive ${isAlive()})\n${mask(error)}`);
}

export async function launchTunnel({ originPort, outDir, label = "tunnel" }) {
  const metricsPort = await freePort();
  const home = join(outDir, `home-${label}-${Date.now()}`);
  await mkdir(home, { recursive: true });
  const args = tunnelArgs({ originPort, metricsPort });
  const child = spawn(BINARY, args, {
    // BFF と同じく資格情報を渡さず、HOME だけを起動ごとに分ける
    env: { HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  const collect = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n")) if (line.trim()) lines.push(line.trim());
    });
  };
  collect(child.stdout);
  collect(child.stderr);

  const startedAt = performance.now();
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, at: performance.now() }));
  });

  return {
    child,
    args,
    home,
    metricsPort,
    lines,
    exit,
    startedAt,
    waitReady: (timeoutMs) =>
      waitUntilReady({ metricsPort, startedAt, lines, isAlive: () => child.exitCode === null, timeoutMs }),
    async stop({ timeoutMs = 15000 } = {}) {
      if (child.exitCode !== null) return { alreadyExited: true, code: child.exitCode, ms: 0 };
      const stopAt = performance.now();
      child.kill("SIGTERM");
      const result = await Promise.race([exit, sleep(timeoutMs).then(() => null)]);
      if (!result) {
        child.kill("SIGKILL");
        await exit;
      }
      return {
        alreadyExited: false,
        code: child.exitCode ?? result?.code,
        signal: result?.signal,
        ms: Math.round(performance.now() - stopAt),
      };
    },
    async saveLog(name) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `${name}.log`), mask(lines.join("\n")));
    },
  };
}
