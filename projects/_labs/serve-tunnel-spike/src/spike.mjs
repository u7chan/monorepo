#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, constants, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startOrigin } from "./origin.mjs";
import { writeReport } from "./report.mjs";
import { BINARY, freePort, launchTunnel, mask, tunnelArgs, waitUntilReady } from "./tunnel.mjs";

const execFileP = promisify(execFile);
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(projectDir, "out");
const cli = process.argv.slice(2);
const skipCycles = cli.includes("--skip-cycles");
const skipOrphan = cli.includes("--skip-orphan");
const cyclesArg = cli.find((arg) => arg.startsWith("--cycles="));
const cycleCount = cyclesArg ? Number(cyclesArg.split("=")[1]) : 3;
if (!Number.isInteger(cycleCount) || cycleCount < 1) throw new Error(`invalid --cycles: ${cycleCount}`);
const checks = [];
const cleanups = [];
const runStartedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(id, title, verdict, facts, summary, note = "") {
  checks.push({ id, title, verdict, facts, summary, note });
  console.log(`[${verdict}] ${id}: ${mask(summary)}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tcpConnect(host, port, timeoutMs = 5000) {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, ms: Math.round(performance.now() - started), error: "timeout" });
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve({ ok: true, ms: Math.round(performance.now() - started) });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, ms: Math.round(performance.now() - started), error: error.code ?? error.message });
    });
  });
}

async function waitForDoh(host, timeoutMs = 60000, startedAt = performance.now()) {
  let attempts = 0;
  let lastStatus = null;
  let lastError = null;
  while (performance.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const body = await res.json();
        const answers = (body.Answer ?? []).filter((answer) => answer.type === 1);
        if (answers.length > 0) {
          return { at: Math.round(performance.now() - startedAt), answers: answers.length, attempts, lastStatus };
        }
      }
    } catch (error) {
      lastError = error.cause?.code ?? error.name;
    }
    await sleep(500);
  }
  return { at: null, answers: 0, attempts, lastStatus, lastError };
}

async function fetchUntilOk(url, init = {}, timeoutMs = 30000, startedAt = performance.now()) {
  let lastError = "unknown";
  while (performance.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      if (res.status < 500) return { res, text: await res.text(), ms: Math.round(performance.now() - startedAt) };
      lastError = `HTTP ${res.status}`;
      await res.text().catch(() => {});
    } catch (error) {
      lastError = error.cause?.code ?? error.name;
    }
    await sleep(500);
  }
  throw new Error(`not reachable: ${lastError}`);
}

async function curlInfo(url) {
  try {
    const { stdout } = await execFileP(
      "curl",
      ["-sS", "--max-time", "20", "-o", "/dev/null", "-D", "-", "-w", "\n__META__ %{http_version} %{http_code} %{time_total}", url],
      { encoding: "utf8" },
    );
    const [meta, version, status, total] = stdout.trim().split("\n").at(-1).split(" ");
    return { meta, httpVersion: version, status: Number(status), totalSeconds: Number(total) };
  } catch (error) {
    return { error: error.message };
  }
}

async function probeMetrics(port) {
  const result = {};
  for (const path of ["/quicktunnel", "/ready", "/metrics", "/config", "/debug/pprof/"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
      result[path] = { status: res.status, contentType: res.headers.get("content-type") };
      await res.text().catch(() => {});
    } catch {
      result[path] = { status: 0 };
    }
  }
  return result;
}

async function waitForPrechecks(tunnel, timeoutMs = 25000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const entries = tunnel.lines.flatMap((line) => {
      const matched = /\|\s*(DNS Resolution|UDP Connectivity|TCP Connectivity|Cloudflare API)\s+(\S+)\s+(PASS|FAIL)\s+(.*?)\s*\|/.exec(line);
      return matched
        ? [{ component: matched[1], target: matched[2], status: matched[3], detail: matched[4] }]
        : [];
    });
    const summary = tunnel.lines.find((line) => line.includes("SUMMARY:"));
    if (summary && entries.length > 0) {
      return { at: Math.round(performance.now() - started), entries, summary: summary.slice(summary.indexOf("SUMMARY:")) };
    }
    await sleep(500);
  }
  return { at: null, entries: [], summary: null };
}

async function sseArrivals(url) {
  const started = performance.now();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.body) return { status: res.status, arrivals: [], contentType: res.headers.get("content-type") };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const arrivals = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("data: ");
    while (index >= 0) {
      const end = buffer.indexOf("\n\n", index);
      if (end < 0) break;
      arrivals.push(Math.round(performance.now() - started));
      buffer = buffer.slice(end + 2);
      index = buffer.indexOf("data: ");
    }
  }
  return { status: res.status, arrivals, contentType: res.headers.get("content-type") };
}

function websocketEcho(url) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== "function") {
      resolve({ ok: false, skipped: true, error: "WebSocket is not available" });
      return;
    }
    const started = performance.now();
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve({ ok: false, error: "timeout" });
    }, 15000);
    socket.onopen = () => socket.send("hello-from-spike");
    socket.onmessage = (event) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - started);
      socket.close();
      resolve({ ok: true, echoMatches: event.data === "hello-from-spike", ms });
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "error" });
    };
  });
}

async function burst(url, count, holdMs) {
  const started = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      const res = await fetch(`${url}/hold?ms=${holdMs}`, { signal: AbortSignal.timeout(30000) });
      await res.arrayBuffer();
      return res;
    }),
  );
  const statuses = {};
  for (const item of settled) {
    const key = item.status === "fulfilled" ? String(item.value.status) : (item.reason?.name ?? "error");
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  return { requested: count, statuses, ms: Math.round(performance.now() - started) };
}

async function readPpid(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
  } catch {
    return null;
  }
}

async function waitGone(pid, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await sleep(200);
  }
  return !pidAlive(pid);
}

async function runBasic(origin) {
  const tunnel = await launchTunnel({ originPort: origin.port, outDir, label: "basic" });
  const cleanup = () => tunnel.stop();
  cleanups.push(cleanup);
  try {
    const ready = await tunnel.waitReady();
    const readyWall = performance.now();
    const dnsPromise = waitForDoh(ready.hostname, 60000, readyWall);
    const metricsProbes = await probeMetrics(tunnel.metricsPort);
    const quickRes = await fetch(`http://127.0.0.1:${tunnel.metricsPort}/quicktunnel`);
    const quick = await quickRes.json();

    const nonLoopback = [];
    for (const iface of Object.values(networkInterfaces()).flat()) {
      if (iface && !iface.internal && iface.family === "IPv4") {
        nonLoopback.push((await tcpConnect(iface.address, tunnel.metricsPort, 2000)).ok);
      }
    }

    const configLine = tunnel.lines.find((line) => line.includes("was empty")) ?? null;
    const prechecks = await waitForPrechecks(tunnel);
    record(
      "flags",
      "固定版のフラグとログ",
      configLine ? "PASS" : "FAIL",
      {
        args: tunnel.args,
        emptyConfigWarning: configLine,
        precheckLinesSeen: tunnel.lines.some((line) => line.includes("CONNECTIVITY PRE-CHECKS")),
      },
      "--config /dev/null と --url が通り、empty の警告だけが出る",
    );

    const failedPrechecks = prechecks.entries.filter((entry) => entry.status !== "PASS");
    record(
      "outbound-7844",
      "外向き 7844 の TCP / UDP",
      prechecks.entries.length === 0 ? "SKIP" : failedPrechecks.length === 0 ? "PASS" : "FAIL",
      prechecks,
      prechecks.summary ?? "precheck の表が出ない",
      "cloudflared の起動時 precheck。UDP は QUIC、TCP は HTTP/2 の接続結果",
    );

    const dns = await dnsPromise;
    // NXDOMAIN の負のキャッシュ（この環境では約 30 秒）を踏まないよう、最初の問い合わせを遅らせる
    await sleep(5000);
    try {
      const fetched = await fetchUntilOk(
        `${ready.url}/echo`,
        { headers: { origin: "https://example.test", referer: "https://example.test/page" } },
        60000,
        readyWall,
      );
      const originEcho = JSON.parse(fetched.text);
      const publicHeaders = {
        server: fetched.res.headers.get("server"),
        cfRay: fetched.res.headers.get("cf-ray") !== null,
        cfCacheStatus: fetched.res.headers.get("cf-cache-status"),
      };
      const curl = await curlInfo(`${ready.url}/`);
      record(
        "public",
        "公開 URL とヘッダの転送",
        fetched.res.status === 200 && originEcho.marker === "serve-tunnel-spike-origin" ? "PASS" : "FAIL",
        {
          readyAt: ready.readyAt,
          dnsAnswerAfterReadyMs: dns.at,
          dnsAttempts: dns.attempts,
          dnsLastStatus: dns.lastStatus,
          dnsLastError: dns.lastError,
          probeStartAfterReadyMs: 5000,
          firstResponseAfterReadyMs: fetched.ms,
          status: fetched.res.status,
          httpVersionByCurl: curl.httpVersion,
          headers: publicHeaders,
          warningPage: /just a moment|attention required/i.test(fetched.text),
          originSaw: {
            cfConnectingIp: Boolean(originEcho.headers["cf-connecting-ip"]),
            xForwardedFor: Boolean(originEcho.headers["x-forwarded-for"]),
            origin: originEcho.headers.origin ?? null,
            referer: originEcho.headers.referer ?? null,
          },
        },
        `ready の ${dns.at ?? "?"} ms 後に DNS が解決し、${fetched.ms} ms で 200`,
        "DNS が引ける前に問い合わせると NXDOMAIN が約 30 秒キャッシュされるため、DoH の解決と 5 秒の待ちの後に叩いた",
      );
    } catch (error) {
      record(
        "public",
        "公開 URL とヘッダの転送",
        "FAIL",
        { readyAt: ready.readyAt, dnsAnswerAfterReadyMs: dns.at, dnsAttempts: dns.attempts, error: error.message },
        "公開 URL に届かない",
      );
    }

    const directSse = await sseArrivals(`http://127.0.0.1:${origin.port}/sse`);
    const tunnelSse = await sseArrivals(`${ready.url}/sse`);
    const spread = tunnelSse.arrivals.length > 1 ? tunnelSse.arrivals.at(-1) - tunnelSse.arrivals[0] : 0;
    record(
      "sse",
      "SSE のストリーミング",
      "INFO",
      { direct: directSse, tunnel: tunnelSse, tunnelArrivalSpreadMs: spread },
      spread < 200 ? "6 イベントが最後にまとめて届く（バッファされる）" : "イベントが逐次届く",
    );

    const ws = await websocketEcho(`${ready.url.replace(/^https/, "wss")}/ws`);
    record(
      "websocket",
      "WebSocket の upgrade",
      ws.skipped ? "SKIP" : ws.ok ? "INFO" : "FAIL",
      ws,
      ws.ok ? "Quick Tunnel 越しに 101 と echo が通る" : `upgrade 不可: ${ws.error}`,
      "ゲート側で upgrade を通すかは #2808。Quick Tunnel 自体は通す",
    );

    origin.resetStats();
    const burstResult = await burst(ready.url, 240, 1200);
    await sleep(1500);
    const stats = await (await fetch(`http://127.0.0.1:${origin.port}/stats`)).json();
    record(
      "concurrency",
      "同時 200 リクエストの上限",
      burstResult.statuses["429"] ? "PASS" : "INFO",
      { ...burstResult, originPeakInFlight: stats.peakInFlight, originTotal: stats.total },
      `240 並列で ${Object.entries(burstResult.statuses).map(([status, count]) => `${status}=${count}`).join(", ")}`,
    );

    const stopped = await tunnel.stop();
    const dead = await fetch(`${ready.url}/`).catch((error) => ({ status: 0, error }));
    const deadBody = typeof dead.text === "function" ? await dead.text() : "";
    const errorCode =
      /errorCode:\s*(\d{3,4})\b/i.exec(deadBody)?.[1] ?? /Error\s+(\d{3,4})\b/i.exec(deadBody)?.[1] ?? null;
    record(
      "stop",
      "停止後の URL",
      dead.status >= 500 && errorCode === "1033" ? "PASS" : "FAIL",
      { stop: stopped, status: dead.status, errorCode },
      `SIGTERM から ${stopped.ms} ms で終了し、以後は ${dead.status} / ${errorCode ?? "code 不明"}`,
    );

    return { url: ready.url, hostname: ready.hostname, readyAt: ready.readyAt, metricsProbes, quickKeys: Object.keys(quick), quickHasScheme: /^https?:/.test(quick.hostname ?? ""), nonLoopbackReachable: nonLoopback.some(Boolean) };
  } finally {
    await tunnel.stop();
    await tunnel.saveLog("basic").catch(() => {});
    const index = cleanups.indexOf(cleanup);
    if (index >= 0) cleanups.splice(index, 1);
  }
}

async function runCycles(origin, count = 3) {
  const results = [];
  const hostnames = new Set();
  for (let cycle = 1; cycle <= count; cycle++) {
    const tunnel = await launchTunnel({ originPort: origin.port, outDir, label: `cycle-${cycle}` });
    const cleanup = () => tunnel.stop();
    cleanups.push(cleanup);
    try {
      const ready = await tunnel.waitReady();
      hostnames.add(ready.hostname);
      const stopped = await tunnel.stop();
      results.push({
        cycle,
        readyAt: ready.readyAt,
        stopMs: stopped.ms,
        exitCode: stopped.code,
        rejected: tunnel.lines.some((line) => /provisioning failed|status 429/i.test(line)),
      });
      await tunnel.saveLog(`cycle-${cycle}`);
    } catch (error) {
      const rejected = /status 429/i.test(error.message);
      results.push({ cycle, error: error.message, rejected });
      await tunnel.stop();
      await tunnel.saveLog(`cycle-${cycle}-failed`);
      // 429 は作成の上限。続けても同じ結果になるので打ち切る
      if (rejected) break;
    } finally {
      const index = cleanups.indexOf(cleanup);
      if (index >= 0) cleanups.splice(index, 1);
    }
  }
  const readyTimes = results.map((result) => result.readyAt).filter((value) => typeof value === "number");
  const rejected = results.filter((result) => result.rejected);
  const completed = results.filter((result) => !result.rejected && result.exitCode === 0);
  record(
    "restart-cycles",
    "作成と停止の連続",
    rejected.length > 0 ? "INFO" : completed.length === count && hostnames.size === count ? "PASS" : "FAIL",
    {
      results,
      uniqueHostnames: `${hostnames.size}/${completed.length}`,
      minReadyAt: readyTimes.length > 0 ? Math.min(...readyTimes) : null,
      maxReadyAt: readyTimes.length > 0 ? Math.max(...readyTimes) : null,
    },
    rejected.length > 0
      ? `${completed.length} 回成功した後、${rejected[0].cycle} 回目で 429 により拒否された`
      : `${count} 回とも作成・停止でき、URL は毎回変わった`,
  );
}

async function runOrphan(origin) {
  const metricsPort = await freePort();
  const home = join(outDir, `home-orphan-${Date.now()}`);
  await mkdir(home, { recursive: true });
  const launcherCode = `
const { spawn } = require("node:child_process");
const [bin, ...args] = process.argv.slice(1);
const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
process.stdout.write(child.pid + "\\n");
child.stdout.on("data", (chunk) => process.stderr.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
setInterval(() => {}, 1000);
`;
  const launcher = spawn(
    process.execPath,
    ["-e", launcherCode, BINARY, ...tunnelArgs({ originPort: origin.port, metricsPort })],
    { env: { HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const childLines = [];
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk) => {
    for (const line of chunk.split("\n")) if (line.trim()) childLines.push(line.trim());
  });
  const startedAt = performance.now();
  let pid;
  let orphanStop;
  const orphanCleanup = () => {
    if (pid && pidAlive(pid)) process.kill(pid, "SIGKILL");
  };
  try {
    pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("launcher did not report the child pid")), 5000);
      launcher.stdout.on("data", (chunk) => {
        const line = String(chunk).split("\n")[0].trim();
        if (/^\d+$/.test(line)) {
          clearTimeout(timer);
          resolve(Number(line));
        }
      });
      launcher.once("exit", (code) => reject(new Error(`launcher exited early: ${code}`)));
    });
    cleanups.push(orphanCleanup);

    let ready;
    try {
      ready = await waitUntilReady({
        metricsPort,
        startedAt,
        lines: childLines,
        isAlive: () => pidAlive(pid),
      });
    } catch (error) {
      const rejected = /status 429/i.test(error.message);
      record(
        "orphan",
        "BFF の SIGKILL 後に子が残るか",
        rejected ? "SKIP" : "FAIL",
        { error: error.message },
        rejected ? "429 のため未実施" : "トンネルが準備できなかった",
      );
      return;
    }
    launcher.kill("SIGKILL");
    await Promise.race([once(launcher, "exit"), sleep(5000)]);
    await sleep(1000);

    const aliveAfterKill = pidAlive(pid);
    const readyAfterKill = await fetch(`http://127.0.0.1:${metricsPort}/ready`, { signal: AbortSignal.timeout(3000) })
      .then((res) => res.status)
      .catch(() => 0);
    const ppid = await readPpid(pid);
    const reparented = ppid !== null && ppid !== launcher.pid;
    let publicAfterKill = null;
    if (aliveAfterKill) {
      const dns = await waitForDoh(ready.hostname, 60000);
      const fetched = await fetchUntilOk(`${ready.url}/echo`, {}, 60000);
      publicAfterKill = { dnsAnswerMs: dns.at, status: fetched.res.status, ms: fetched.ms };
    }

    if (pidAlive(pid)) process.kill(pid, "SIGTERM");
    const gone = await waitGone(pid, 15000);
    if (!gone) {
      process.kill(pid, "SIGKILL");
      await waitGone(pid, 5000);
    }
    orphanStop = { gone, metricsAfterStop: await fetch(`http://127.0.0.1:${metricsPort}/ready`, { signal: AbortSignal.timeout(2000) }).then((res) => res.status).catch(() => 0) };

    record(
      "orphan",
      "BFF の SIGKILL 後に子が残るか",
      aliveAfterKill && readyAfterKill === 200 ? "PASS" : "FAIL",
      { childPidAliveAfterParentKill: aliveAfterKill, readyAfterParentKill: readyAfterKill, reparented, publicAfterKill, stop: orphanStop },
      aliveAfterKill ? "親を SIGKILL しても cloudflared とトンネルは残る" : "親の終了で子も終わった",
      "BFF を SIGKILL すると子は孤児になり、ゲートが無いまま接続だけが残る。pid ファイルでの掃除が要る（#2805）",
    );
    cleanups.splice(cleanups.indexOf(orphanCleanup), 1);
  } finally {
    if (pid && pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      if (!(await waitGone(pid, 10000))) process.kill(pid, "SIGKILL");
    }
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
    const index = cleanups.indexOf(orphanCleanup);
    if (index >= 0) cleanups.splice(index, 1);
  }
  return { pid, orphanStop };
}

async function main() {
  await access(BINARY, constants.X_OK).catch(() => {
    throw new Error(`${BINARY} が無い。先に node src/install-cloudflared.mjs を実行する`);
  });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const version = (await execFileP(BINARY, ["--version"], { encoding: "utf8" })).stdout.trim();
  const binary = await readFile(BINARY);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const help = (await execFileP(BINARY, ["tunnel", "--help"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })).stdout;
  await writeFile(join(outDir, "help.txt"), help);

  const requiredFlags = ["--config", "--metrics", "--grace-period", "--url", "--no-autoupdate", "--pidfile", "--no-prechecks", "--edge-ip-version", "--region"];
  const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
  const api = await fetch("https://api.trycloudflare.com/", { signal: AbortSignal.timeout(10000) })
    .then((res) => ({ status: res.status }))
    .catch((error) => ({ status: 0, error: error.cause?.code ?? error.message }));
  const tcp7844 = {};
  for (const host of ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"]) {
    tcp7844[host] = await tcpConnect(host, 7844);
  }
  record(
    "preflight",
    "バイナリ・API・7844 の到達性",
    missingFlags.length === 0 && api.status > 0 && Object.values(tcp7844).every((result) => result.ok) ? "PASS" : "FAIL",
    {
      cloudflaredVersion: version,
      binarySha256: sha256,
      missingFlags,
      protocolFlagInHelp: help.includes("--protocol"),
      apiTrycloudflare: api,
      tcp7844,
    },
    `固定版 ${version.split(" ")[2]}、flags 欠け ${missingFlags.length}、API ${api.status}`,
  );

  const origin = await startOrigin();
  try {
    let basic;
    try {
      basic = await runBasic(origin);
    } catch (error) {
      record("basic", "基本シナリオ", "FAIL", { error: error.message }, "基本シナリオが完了しなかった");
    }
    if (basic) {
      record(
        "metrics",
        "メトリクスの公開範囲",
        basic.nonLoopbackReachable ? "FAIL" : "PASS",
        {
          probes: basic.metricsProbes,
          quicktunnelKeys: basic.quickKeys,
          quicktunnelHostnameHasScheme: basic.quickHasScheme,
          nonLoopbackReachable: basic.nonLoopbackReachable,
        },
        "loopback のメトリクスに /config と /debug/pprof/ があり、外部インターフェースからは届かない",
      );
    }
    if (!skipCycles) {
      try {
        await runCycles(origin, cycleCount);
      } catch (error) {
        record("restart-cycles", "作成と停止の連続", "FAIL", { error: error.message }, "連続作成が完了しなかった");
      }
    }
    if (!skipOrphan) {
      try {
        await runOrphan(origin);
      } catch (error) {
        record("orphan", "BFF の SIGKILL 後に子が残るか", "FAIL", { error: error.message }, "孤児の確認が完了しなかった");
      }
    }
  } finally {
    await origin.close();
  }

  for (const entry of await readdir(outDir)) {
    if (entry.startsWith("home-")) await rm(join(outDir, entry), { recursive: true, force: true });
  }
  const report = {
    environment: {
      startedAt: runStartedAt,
      finishedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cloudflared: version,
      sha256,
    },
    checks,
    options: { skipCycles, skipOrphan, cycleCount },
  };
  await writeReport(outDir, report);
  console.log(`\nreport: ${join(outDir, "report.md")}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    for (const cleanup of cleanups) await Promise.resolve(cleanup()).catch(() => {});
    process.exit(130);
  });
}

await main().catch((error) => {
  console.error(mask(error.stack ?? error.message));
  process.exit(1);
});
