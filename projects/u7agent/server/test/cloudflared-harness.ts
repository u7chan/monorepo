// cloudflared のテスト用の偽物。実プロセスも実ネットワークも使わず、`spawn` と、子のメトリクス (loopback) だけを模す。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createCloudflaredLauncher,
  type CloudflaredHandle,
  type CloudflaredLauncher,
  type CloudflaredLauncherOptions,
  type ProcessReading,
} from "../src/cloudflared";
import { GRACEFUL_SHUTDOWN_LOG, NOT_READY_BODY, READY_BODY } from "./fixtures/cloudflared-output";

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(5);
  }
}

/** 解決も reject もしていないこと */
export async function isPending(promise: Promise<unknown>, ms = 80): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    sleep(ms).then(() => true),
  ]);
}

export async function writeExecutable(path: string, content = "#!/bin/sh\nexit 0\n"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  closed = false;

  constructor(
    readonly pid: number,
    private readonly respond: (child: FakeChild, signal: NodeJS.Signals) => boolean,
    private readonly onClosed: () => void,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return this.respond(this, signal);
  }

  writeLog(text: string, stream: "stdout" | "stderr" = "stderr"): void {
    this[stream].write(text);
  }

  /** 本物と同じく、出力を流し切ってから `close` を出す */
  async exit(code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    await new Promise((done) => setImmediate(done));
    this.onClosed();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

export interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  child: FakeChild;
  metricsPort: number;
}

export interface Harness {
  base: string;
  binary: string;
  /** `binary` の実体 (起動に使われる) */
  realBinary: string;
  storeDir: string;
  /** 実体で解決した `tunnel/` */
  stateDir: string;
  rootCwd: string;
  writableRoot: string;
  calls: SpawnCall[];
  /**
   * 子のメトリクスの応答。`quickTunnelBody` が null なら `/quicktunnel` は 404。
   * `gate` があれば、どの応答もそれが解けるまで保留する (応答を待っている間の停止・終了・期限を試すため)
   */
  metrics: { quickTunnelBody: string | null; quickTunnelStatus: number; readyStatus: number; gate?: Promise<void> };
  behavior: {
    /** SIGTERM に応えず、SIGKILL まで残る */
    ignoreSigterm: boolean;
    /** kill が拒否される (EPERM 相当。戻り値は false で、子は何も受けない) */
    killDenied?: boolean;
    /** メトリクスの待受が、子のものか。既定は "yes" */
    listenerOwner?: "yes" | "no" | "unknown";
    /** 子ができた直後に呼ぶ (出力や終了を仕込む) */
    onSpawn?: (call: SpawnCall) => void;
    /** spawn に失敗した子 (`error` が出て終わる) を返す */
    spawnError?: Error;
  };
  launcher: CloudflaredLauncher;
  launch(originPort?: number): CloudflaredHandle;
  dispose(): Promise<void>;
}

export async function createHarness(
  overrides: Partial<CloudflaredLauncherOptions> = {},
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Harness> {
  // 既定の書き込み先に /tmp が入るため、テストの置き場 (/tmp 配下) を書き込み先と取り違えないよう差し替える
  const base = await realpath(await mkdtemp(join(tmpdir(), "u7agent-cloudflared-")));
  const binary = join(base, "bin", "cloudflared");
  await writeExecutable(binary);
  const storeDir = join(base, "store");
  const rootCwd = join(base, "workspace");
  const writableRoot = join(base, "agent-writable");
  for (const dir of [storeDir, rootCwd, writableRoot]) await mkdir(dir, { recursive: true });

  const calls: SpawnCall[] = [];
  const servers = new Set<Server>();
  const handles: CloudflaredHandle[] = [];
  let nextPid = 40_000 + Math.floor(Math.random() * 10_000);

  const harness: Harness = {
    base,
    binary,
    realBinary: await realpath(binary),
    storeDir,
    stateDir: join(await realpath(storeDir), "tunnel"),
    rootCwd,
    writableRoot,
    calls,
    metrics: { quickTunnelBody: null, quickTunnelStatus: 200, readyStatus: 503 },
    behavior: { ignoreSigterm: false },
    launcher: undefined as unknown as CloudflaredLauncher,
    launch: (originPort = 41_234) => {
      const handle = harness.launcher.launch({ originPort });
      handles.push(handle);
      return handle;
    },
    dispose: async () => {
      await Promise.all(handles.map((handle) => handle.stop()));
      await Promise.all([...servers].map((server) => new Promise((done) => server.close(done))));
      await rm(base, { recursive: true, force: true });
    },
  };

  const startMetrics = (port: number): Server => {
    const server = createServer(async (request, response) => {
      await harness.metrics.gate;
      if (request.url === "/quicktunnel" && harness.metrics.quickTunnelBody !== null) {
        response.writeHead(harness.metrics.quickTunnelStatus, { "content-type": "text/plain" });
        response.end(harness.metrics.quickTunnelBody);
      } else if (request.url === "/ready") {
        response.writeHead(harness.metrics.readyStatus);
        response.end(harness.metrics.readyStatus === 200 ? READY_BODY : NOT_READY_BODY);
      } else {
        response.writeHead(404);
        response.end("not found");
      }
    });
    server.on("error", () => {});
    server.listen(port, "127.0.0.1");
    servers.add(server);
    return server;
  };

  const spawn: NonNullable<CloudflaredLauncherOptions["spawn"]> = (command, args, options) => {
    const metricsPort = Number(/^127\.0\.0\.1:(\d+)$/.exec(args[args.indexOf("--metrics") + 1] ?? "")?.[1]);
    let metricsServer: Server | undefined;
    const child = new FakeChild(
      (nextPid += 1),
      (self, signal) => {
        if (harness.behavior.killDenied) return false;
        if (signal === "SIGKILL") void self.exit(null, "SIGKILL");
        else if (!harness.behavior.ignoreSigterm) {
          self.writeLog(GRACEFUL_SHUTDOWN_LOG);
          void self.exit(0);
        }
        return true;
      },
      () => metricsServer?.close(),
    );
    const call: SpawnCall = { command, args, env: options.env, cwd: options.cwd, child, metricsPort };
    calls.push(call);
    if (harness.behavior.spawnError) {
      const error = harness.behavior.spawnError;
      setImmediate(() => {
        child.emit("error", error);
        void child.exit(-2);
      });
      return child as unknown as ChildProcess;
    }
    metricsServer = startMetrics(metricsPort);
    harness.behavior.onSpawn?.(call);
    return child as unknown as ChildProcess;
  };

  const readProcess = async (pid: number): Promise<ProcessReading> => {
    const call = calls.find((entry) => entry.child.pid === pid);
    return call
      ? {
          state: "present",
          startedAtMs: 1_700_000_000_000 + pid,
          exe: harness.realBinary,
          argv: [call.command, ...call.args],
          cwd: call.cwd,
        }
      : {
          state: "present",
          startedAtMs: 1_700_000_000_000,
          exe: process.execPath,
          argv: [process.execPath],
          cwd: process.cwd(),
        };
  };

  harness.launcher = createCloudflaredLauncher({
    env: { PI_CLOUDFLARED_PATH: binary, ...extraEnv },
    sessionStoreDir: storeDir,
    rootCwd,
    writeRoots: [writableRoot],
    instancePort: 4317,
    spawn,
    readProcess,
    listenerOwner: async () => harness.behavior.listenerOwner ?? "yes",
    deadlineMs: 3000,
    pollIntervalMs: 10,
    stopGraceMs: 150,
    ...overrides,
  });
  return harness;
}
