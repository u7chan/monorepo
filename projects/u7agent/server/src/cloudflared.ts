/**
 * 一時共有 (Quick Tunnel) の起動基盤: `cloudflared` の解決・起動・停止と、残った子の掃除。
 * BFF が子プロセスを起こす唯一の例外 (lint の許可もここと sandbox/ だけ)。契約と採らなかった案は docs/service-tunnel.md を参照する。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { isInsideRoot } from "./path-strings";
import { processStartedAtMs } from "./proc-stat";
import { fixedLandlockWriteRoots } from "./sandbox/landlock";
import { resolveTrustedExecutable } from "./sandbox/runtime-info";

export const CLOUDFLARED_PATH_ENV = "PI_CLOUDFLARED_PATH";
export const CLOUDFLARED_IMAGE_DIR = "/usr/local/libexec/u7agent";
const BINARY_NAME = "cloudflared";
const STATE_DIR_NAME = "tunnel";

/** 実測の 4〜5 秒には合わせない。QUIC から HTTP/2 への切り替えが挟まる環境を見込む */
export const CLOUDFLARED_READY_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 200;
const PROBE_TIMEOUT_MS = 2_000;
/** `--grace-period` (5 秒) より短くしない。猶予の途中で SIGKILL して、進行中の応答を切らないため */
const STOP_GRACE_MS = 7_000;
const KILL_WAIT_MS = 2_000;
const SWEEP_TERM_WAIT_MS = 3_000;
const SWEEP_POLL_MS = 100;
const TAIL_LINES = 20;
const RECENT_LINES = 200;
const MAX_LINE_CHARS = 2_000;
const MAX_PROBE_BODY_CHARS = 4_096;

/** サンドボックスの PATH に足す `$HOME/.local/libexec/u7agent` には置かない。エージェントが名前で呼べてしまうため */
export function cloudflaredDevDir(home = homedir()): string {
  return join(home, ".local", "libexec", "u7agent-bff");
}

export type CloudflaredUnavailableReason =
  | "unsupported_platform"
  | "binary_missing"
  | "binary_in_write_root"
  | "store_missing"
  | "store_in_write_root"
  | "store_unusable";

export type CloudflaredResolution =
  | { available: true; binary: string; stateDir: string }
  | { available: false; reason: CloudflaredUnavailableReason };

export interface CloudflaredEnvironment {
  env: NodeJS.ProcessEnv;
  /** 会話ストア。永続化なしの構成 (null) では使えない */
  sessionStoreDir: string | null | undefined;
  /** ワークスペースの root。エージェントが書ける場所なので、バイナリも置き場もこの配下には置かせない */
  rootCwd: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** テスト用の差し替え。既定は `CLOUDFLARED_IMAGE_DIR` と `cloudflaredDevDir()` */
  trustedDirs?: readonly string[];
  /** テスト用の差し替え。既定は Landlock の固定の書き込み先 (`/tmp` を含む) */
  writeRoots?: readonly string[];
}

function pathForms(path: string): string[] {
  const lexical = resolve(path);
  try {
    const real = realpathSync(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

/** 字句だけでも実体だけでも比べない。書き込み先が symlink のときと未作成のときで、どちらかが外れる */
function agentWritableRoots(input: CloudflaredEnvironment, home: string): string[] {
  const fixed = input.writeRoots ?? fixedLandlockWriteRoots(home).map((root) => root.path);
  return [...new Set([...fixed, input.rootCwd].flatMap(pathForms))];
}

function isInsideAny(roots: readonly string[], target: string): boolean {
  return roots.some((root) => isInsideRoot(root, target, sep));
}

function realExecutable(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) return undefined;
    accessSync(real, constants.X_OK);
    return real;
  } catch {
    return undefined;
  }
}

/**
 * `PATH` は探さない。エージェントが書ける場所のバイナリを拾うため。
 * `PI_CLOUDFLARED_PATH` を指定したら別の候補へ落とさない。意図しないバイナリを黙って使わないため。
 */
export function resolveCloudflared(input: CloudflaredEnvironment): CloudflaredResolution {
  const home = input.home ?? homedir();
  const explicit = input.env[CLOUDFLARED_PATH_ENV]?.trim();
  const unavailable = (reason: CloudflaredUnavailableReason): CloudflaredResolution => ({ available: false, reason });

  if ((input.platform ?? process.platform) !== "linux" && !explicit) return unavailable("unsupported_platform");
  if (!input.sessionStoreDir) return unavailable("store_missing");

  const binary = explicit
    ? realExecutable(explicit)
    : resolveTrustedExecutable(BINARY_NAME, input.trustedDirs ?? [CLOUDFLARED_IMAGE_DIR, cloudflaredDevDir(home)]);
  if (!binary) return unavailable("binary_missing");

  const writableRoots = agentWritableRoots(input, home);
  if (isInsideAny(writableRoots, binary)) return unavailable("binary_in_write_root");

  let realStore: string;
  try {
    realStore = realpathSync(input.sessionStoreDir);
  } catch {
    return unavailable("store_missing");
  }
  const named = join(realStore, STATE_DIR_NAME);
  let stateDir = named;
  try {
    stateDir = realpathSync(named);
  } catch {
    // 未作成 (起動のときに作る)
  }
  if (isInsideAny(writableRoots, stateDir) || isInsideAny(writableRoots, realStore)) {
    return unavailable("store_in_write_root");
  }
  return { available: true, binary, stateDir };
}

export function cloudflaredUnavailableMessage(reason: CloudflaredUnavailableReason): string {
  switch (reason) {
    case "unsupported_platform":
      return "一時共有は Linux だけで使えます (他の OS は PI_CLOUDFLARED_PATH で cloudflared を指定してください)";
    case "binary_missing":
      return "cloudflared が見つかりません (イメージに同梱、dev は pnpm dev が配置、または PI_CLOUDFLARED_PATH で指定)";
    case "binary_in_write_root":
      return "cloudflared の実体がエージェントの書き込める場所にあるため、使えません";
    case "store_missing":
      return "会話ストアが無い構成では使えません (PI_SESSION_STORE を確認してください)";
    case "store_in_write_root":
      return "会話ストアがエージェントの書き込める場所にあるため、使えません";
    case "store_unusable":
      return "会話ストアに一時共有の作業場所を作れません";
  }
}

export function cloudflaredStatusLine(resolution: CloudflaredResolution): string {
  return resolution.available ? "tunnel: available" : `tunnel: unavailable (${resolution.reason})`;
}

export type CloudflaredFailureKind =
  | "unavailable"
  | "network"
  | "rejected"
  | "timeout"
  | "exited"
  // 呼び出し側の stop() による中断。失敗ではないので、固定文言を出す側は区別して扱う
  | "aborted";

/** `ready` の失敗。生の出力は載せず、ログへ出すときのために末尾 (マスク済み) だけを持つ */
export class CloudflaredLaunchError extends Error {
  constructor(
    readonly kind: CloudflaredFailureKind,
    readonly outputTail = "",
    readonly unavailableReason?: CloudflaredUnavailableReason,
    cause?: unknown,
  ) {
    super(`cloudflared launch failed: ${kind}`, { cause });
    this.name = "CloudflaredLaunchError";
  }
}

export interface CloudflaredExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stderr の末尾 (`*.trycloudflare.com` はマスク済み) */
  stderrTail: string;
}

export interface CloudflaredHandle {
  /** 公開 URL。`/ready` が 200 になるまで解決しない (URL が出ただけでは利用者へ見せない) */
  ready: Promise<{ url: string }>;
  /** `ready` の後の、`stop()` によらない終了を通知する。起動中の終了は `ready` の reject で伝え、`stop()` 後は解決しない */
  exited: Promise<CloudflaredExit>;
  /** 起動中でも呼べて、起動を中断する。冪等。失敗した起動の片付けもここで待てる (`ready` の reject は片付けより先) */
  stop(): Promise<void>;
}

export interface CloudflaredSweepReport {
  killed: number;
  removedRecords: number;
  removedHomes: number;
}

export interface CloudflaredLauncher {
  /** 起動のたびに確かめ直せる (バイナリや置き場が後から差し替えられていないか) */
  availability(): CloudflaredResolution;
  /** ハンドルをすぐ返す。起動の失敗は `ready` の reject で伝える (`originPort` が不正なときだけ同期で投げる) */
  launch(input: { originPort: number }): CloudflaredHandle;
  /** 前の BFF が残した子を掃除する。何度呼んでも 1 回だけ走り、`launch` はこれを待ってから起動する */
  sweepOrphans(): Promise<CloudflaredSweepReport>;
}

export type ProcessReading =
  | { state: "gone" }
  | { state: "unknown" }
  | { state: "present"; startedAtMs: number; exe: string; argv: string[] };

type ChildSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; stdio: ["ignore", "pipe", "pipe"]; windowsHide: true },
) => ChildProcess;

export interface CloudflaredLauncherOptions extends CloudflaredEnvironment {
  /** BFF の待受ポート。記録のファイル名に入れて、同じ会話ストアを使う 2 本目の BFF と衝突させない */
  instancePort: number;
  log?: (line: string) => void;
  /** 以下はテスト用の差し替え */
  spawn?: ChildSpawn;
  readProcess?: (pid: number) => Promise<ProcessReading>;
  deadlineMs?: number;
  stopGraceMs?: number;
  pollIntervalMs?: number;
  sweepTermWaitMs?: number;
}

/** 引数は固定。向き先は呼び出し側が渡す loopback のポートだけで、外部の入力を連結しない */
function cloudflaredArgs(input: { metricsPort: number; originPort: number }): string[] {
  return [
    "tunnel",
    "--no-autoupdate",
    // 空の設定を読ませる。エージェントが書ける場所の設定ファイルの ingress は --url より優先されるため
    "--config",
    "/dev/null",
    "--metrics",
    `127.0.0.1:${input.metricsPort}`,
    "--grace-period",
    "5s",
    "--url",
    `http://127.0.0.1:${input.originPort}`,
  ];
}

/** BFF の env は継承しない (LLM のキーや master key を子へ渡さない) */
function childEnv(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, NO_AUTOUPDATE: "true" };
  for (const name of ["SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

function maskTunnelHostnames(text: string): string {
  return text.replace(/\b([a-z0-9-]+)\.trycloudflare\.com\b/gi, (match, label: string) =>
    label.toLowerCase() === "api" ? match : "<random>.trycloudflare.com",
  );
}

/** 起動ログの `https://<name>.trycloudflare.com`。免責文のリンクや作成 API (`api.`) は拾わない */
function tunnelHostFromLogLine(line: string): string | undefined {
  for (const match of line.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com/gi)) {
    const label = match[1]?.toLowerCase();
    if (label && label !== "api") return `${label}.trycloudflare.com`;
  }
  return undefined;
}

/** `/quicktunnel` の `{"hostname":"…"}`。scheme が付く値があり得るので外し、想定外の形は採らない */
function hostnameFromQuickTunnel(body: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const raw = typeof value === "object" && value !== null ? (value as { hostname?: unknown }).hostname : undefined;
  if (typeof raw !== "string") return undefined;
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(host) && !host.startsWith("api.")
    ? host
    : undefined;
}

/** 未知の文言は `exited` に倒す。7844 に届かない失敗は再試行が続くため、`timeout` に見える */
function classifyFailure(lines: readonly string[], cause: "exit" | "deadline"): CloudflaredFailureKind {
  const text = lines.join("\n");
  if (/provisioning failed with status \d+/i.test(text)) return "rejected";
  if (/failed to request quick tunnel/i.test(text)) return "network";
  return cause === "deadline" ? "timeout" : "exited";
}

function lineCollector(onLine: (line: string) => void): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  const emit = (line: string): void => onLine(line.replace(/\r$/, "").slice(0, MAX_LINE_CHARS));
  return {
    push(chunk) {
      const lines = (partial + (typeof chunk === "string" ? chunk : decoder.write(chunk))).split("\n");
      // 改行の来ない出力でメモリを使い切らないよう、持ち越す断片に上限を置く
      partial = (lines.pop() ?? "").slice(-MAX_LINE_CHARS);
      lines.forEach(emit);
    },
    end() {
      const rest = partial + decoder.end();
      partial = "";
      if (rest) emit(rest);
    },
  };
}

function probeLoopback(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((settle) => {
    let done = false;
    const finish = (status: number, body: string): void => {
      if (done) return;
      done = true;
      settle({ status, body });
    };
    // fetch は env のプロキシ設定に従い得るので、loopback は http で直接引く
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", agent: false, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_PROBE_BODY_CHARS) res.destroy();
        });
        res.on("end", () => finish(res.statusCode ?? 0, body));
        res.on("close", () => finish(res.statusCode ?? 0, body));
        res.on("error", () => finish(0, ""));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(0, "");
    });
    req.on("error", () => finish(0, ""));
    req.end();
  });
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((settle, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? settle(port) : fail(new Error("no loopback port"))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** 待たなかった側のタイマーを残さない。猶予の分だけプロセスの終了が遅れることを避ける */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolveWithin) => {
    const timer = setTimeout(() => resolveWithin(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolveWithin(true);
    });
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolvePromise = onResolve;
    rejectPromise = onReject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** `/proc` から読む。居ない (gone) と読めない (unknown) を分け、読めないものは居るものとして扱う側へ倒す */
async function readProcessReading(pid: number): Promise<ProcessReading> {
  try {
    const startedAtMs = await processStartedAtMs(pid);
    if (startedAtMs === undefined) return { state: "gone" };
    if (startedAtMs === 0) return { state: "unknown" };
    const [exe, cmdline] = await Promise.all([readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`, "utf8")]);
    return { state: "present", startedAtMs, exe, argv: cmdline.split("\0").slice(0, -1) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "gone" } : { state: "unknown" };
  }
}

const RECORD_FILE = /^pid-\d{1,5}-[0-9a-f]{8}\.json$/;
const HOME_DIR = /^home-\d{1,5}-[0-9a-f]{8}$/;

const recordSchema = z.object({
  version: z.literal(1),
  owner: z.object({ pid: z.number().int().positive(), startedAtMs: z.number().int().nonnegative() }),
  home: z.string().min(1),
  child: z
    .object({
      pid: z.number().int().positive(),
      startedAtMs: z.number().int().nonnegative(),
      exe: z.string().min(1),
      argv: z.array(z.string()).max(32),
    })
    .nullable(),
});
type LaunchRecord = z.infer<typeof recordSchema>;

async function readRecord(path: string): Promise<LaunchRecord | undefined> {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeRecord(path: string, record: LaunchRecord): Promise<void> {
  const partial = `${path}.tmp`;
  await writeFile(partial, JSON.stringify(record), { mode: 0o600 });
  await rename(partial, path);
}

/** 引数の形も記録と照合する。生成と同じ関数で組み直すので、固定の形は 1 か所にしか無い */
function hasFixedTunnelArgs(argv: readonly string[]): boolean {
  const metrics = /^127\.0\.0\.1:(\d{1,5})$/.exec(argv[6] ?? "")?.[1];
  const origin = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(argv[10] ?? "")?.[1];
  if (!metrics || !origin) return false;
  const expected = cloudflaredArgs({ metricsPort: Number(metrics), originPort: Number(origin) });
  return argv.length === expected.length + 1 && expected.every((arg, index) => argv[index + 1] === arg);
}

type ReadProcess = (pid: number) => Promise<ProcessReading>;

async function ownerIsAlive(owner: LaunchRecord["owner"], readProcess: ReadProcess): Promise<boolean> {
  const reading = await readProcess(owner.pid);
  if (reading.state === "gone") return false;
  if (reading.state === "unknown") return true;
  // pid が別のプロセスに再利用されていれば、起動時刻が違う
  return reading.startedAtMs === owner.startedAtMs;
}

/** 記録だけを根拠にすると、書き換えられた記録で他のプロセスを殺せてしまう。実体・起動時刻・cmdline が揃うときだけ真 */
async function isRecordedChild(
  child: NonNullable<LaunchRecord["child"]>,
  binary: string,
  readProcess: ReadProcess,
): Promise<boolean> {
  const reading = await readProcess(child.pid);
  return (
    reading.state === "present" &&
    reading.startedAtMs === child.startedAtMs &&
    reading.exe === child.exe &&
    child.exe === binary &&
    reading.argv.length === child.argv.length &&
    reading.argv.every((arg, index) => arg === child.argv[index]) &&
    hasFixedTunnelArgs(reading.argv)
  );
}

async function terminateRecordedChild(
  child: NonNullable<LaunchRecord["child"]>,
  binary: string,
  readProcess: ReadProcess,
  termWaitMs: number,
): Promise<void> {
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(child.pid, name);
    } catch {
      // 既に終了している
    }
  };
  signal("SIGTERM");
  const until = Date.now() + termWaitMs;
  while (Date.now() < until) {
    if (!(await isRecordedChild(child, binary, readProcess))) return;
    await sleep(SWEEP_POLL_MS);
  }
  // 待つ間に pid が再利用されていないことを、もう一度確かめてから送る
  if (await isRecordedChild(child, binary, readProcess)) signal("SIGKILL");
}

async function sweepStateDir(
  stateDir: string,
  binary: string,
  readProcess: ReadProcess,
  termWaitMs: number,
): Promise<CloudflaredSweepReport> {
  const report: CloudflaredSweepReport = { killed: 0, removedRecords: 0, removedHomes: 0 };
  const names = await readdir(stateDir).catch(() => [] as string[]);
  const liveHomes = new Set<string>();

  for (const name of names.filter((entry) => RECORD_FILE.test(entry)).sort()) {
    const path = join(stateDir, name);
    const record = await readRecord(path);
    // 書いた BFF が生きているあいだは、その子も専用 HOME も他のインスタンスのものなので触らない
    if (record && (await ownerIsAlive(record.owner, readProcess))) {
      liveHomes.add(record.home);
      continue;
    }
    if (record?.child && (await isRecordedChild(record.child, binary, readProcess))) {
      await terminateRecordedChild(record.child, binary, readProcess, termWaitMs);
      report.killed += 1;
    }
    await rm(path, { force: true });
    report.removedRecords += 1;
  }

  // 記録を消したあとの専用 HOME と、SIGKILL で残った HOME。会話ストアは永続ボリュームのことがあり、放置すると溜まる
  for (const name of await readdir(stateDir).catch(() => [] as string[])) {
    if (!HOME_DIR.test(name) || liveHomes.has(name)) continue;
    await rm(join(stateDir, name), { recursive: true, force: true });
    report.removedHomes += 1;
  }
  return report;
}

interface LiveRun {
  killSync(): void;
}
const liveRuns = new Set<LiveRun>();
let exitHookInstalled = false;

/** BFF の終了処理が走らなかった経路 (例外・process.exit) でも、子を残さないための最終手段 */
export function killLiveCloudflared(): void {
  for (const run of liveRuns) run.killSync();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killLiveCloudflared);
}

export function createCloudflaredLauncher(options: CloudflaredLauncherOptions): CloudflaredLauncher {
  const home = options.home ?? homedir();
  const log = options.log ?? (() => {});
  const spawnChild: ChildSpawn =
    options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
  const readProcess = options.readProcess ?? readProcessReading;
  const deadlineMs = options.deadlineMs ?? CLOUDFLARED_READY_DEADLINE_MS;
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const sweepTermWaitMs = options.sweepTermWaitMs ?? SWEEP_TERM_WAIT_MS;

  const availability = (): CloudflaredResolution => resolveCloudflared({ ...options, home });

  let sweeping: Promise<CloudflaredSweepReport> | undefined;
  const sweepOrphans = (): Promise<CloudflaredSweepReport> =>
    (sweeping ??= (async () => {
      const resolution = availability();
      const empty: CloudflaredSweepReport = { killed: 0, removedRecords: 0, removedHomes: 0 };
      if (!resolution.available) return empty;
      try {
        const report = await sweepStateDir(resolution.stateDir, resolution.binary, readProcess, sweepTermWaitMs);
        if (report.killed > 0) log(`tunnel: stopped ${report.killed} leftover cloudflared process(es)`);
        return report;
      } catch {
        // 掃除は best-effort。失敗しても BFF の起動と新しい起動は止めない
        return empty;
      }
    })());

  function launch({ originPort }: { originPort: number }): CloudflaredHandle {
    if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65_535) {
      throw new RangeError("originPort must be an integer between 1 and 65535");
    }
    installExitHook();

    const abort = new AbortController();
    const aborted = new Promise<void>((onAbort) =>
      abort.signal.addEventListener("abort", () => onAbort(), { once: true }),
    );
    const ready = deferred<{ url: string }>();
    const exited = deferred<CloudflaredExit>();
    // 呼び出し側が待たない失敗 (stop() で中断した後など) で unhandled rejection にしない
    ready.promise.catch(() => {});

    let stopRequested = false;
    let selfKilled = false;
    let child: ChildProcess | undefined;
    let end: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;
    const childEnd = deferred<void>();
    const recent: string[] = [];
    const stderrLines: string[] = [];
    let logHost: string | undefined;
    let homePath: string | undefined;
    let recordPath: string | undefined;

    const tail = (lines: readonly string[]): string => maskTunnelHostnames(lines.slice(-TAIL_LINES).join("\n"));
    const failure = (kind: CloudflaredFailureKind): CloudflaredLaunchError =>
      new CloudflaredLaunchError(kind, tail(recent));
    const throwIfAborted = (): void => {
      if (abort.signal.aborted) throw failure("aborted");
    };

    const live: LiveRun = {
      killSync() {
        try {
          child?.kill("SIGKILL");
        } catch {
          // 既に終了している
        }
        for (const path of [homePath, recordPath]) {
          if (!path) continue;
          try {
            rmSync(path, { recursive: true, force: true });
          } catch {
            // exit の中で出来る範囲の後始末。残りは次の起動時の掃除に任せる
          }
        }
      },
    };

    const onLine = (stream: "stdout" | "stderr") => (line: string) => {
      recent.push(line);
      if (recent.length > RECENT_LINES) recent.shift();
      if (stream === "stderr") {
        stderrLines.push(line);
        if (stderrLines.length > TAIL_LINES) stderrLines.shift();
      }
      // URL の代替取得は、`/quicktunnel` が引けないときのためだけに持つ
      logHost ??= tunnelHostFromLogLine(line);
    };

    async function prepare(): Promise<{ binary: string; stateDir: string }> {
      await sweepOrphans();
      throwIfAborted();
      // 起動のたびに、バイナリと置き場がエージェントの書けない場所のままであることを確かめ直す
      const resolution = availability();
      if (!resolution.available) throw new CloudflaredLaunchError("unavailable", "", resolution.reason);
      try {
        await mkdir(resolution.stateDir, { recursive: true, mode: 0o700 });
        await chmod(resolution.stateDir, 0o700);
      } catch {
        throw new CloudflaredLaunchError("unavailable", "", "store_unusable");
      }
      return resolution;
    }

    async function begin(binary: string, stateDir: string, metricsPort: number): Promise<void> {
      const id = randomBytes(4).toString("hex");
      const homeName = `home-${options.instancePort}-${id}`;
      const ownerReading = await readProcess(process.pid);
      // 記録は専用 HOME より先に書く。記録の無い HOME が生きている起動のものだと取り違えないため
      if (ownerReading.state === "present") {
        recordPath = join(stateDir, `pid-${options.instancePort}-${id}.json`);
        await writeRecord(recordPath, {
          version: 1,
          owner: { pid: process.pid, startedAtMs: ownerReading.startedAtMs },
          home: homeName,
          child: null,
        });
      }
      homePath = join(stateDir, homeName);
      liveRuns.add(live);
      await mkdir(homePath, { mode: 0o700 });
      throwIfAborted();

      child = spawnChild(binary, cloudflaredArgs({ metricsPort, originPort }), {
        env: childEnv(options.env, homePath),
        cwd: homePath,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = lineCollector(onLine("stdout"));
      const stderr = lineCollector(onLine("stderr"));
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        end ??= { code: null, signal: null, error };
        childEnd.resolve();
      });
      child.once("close", (code, signal) => {
        stdout.end();
        stderr.end();
        end ??= { code, signal };
        childEnd.resolve();
      });

      if (recordPath && ownerReading.state === "present" && child.pid !== undefined) {
        const childReading = await readProcess(child.pid);
        if (childReading.state === "present") {
          await writeRecord(recordPath, {
            version: 1,
            owner: { pid: process.pid, startedAtMs: ownerReading.startedAtMs },
            home: homeName,
            child: {
              pid: child.pid,
              startedAtMs: childReading.startedAtMs,
              exe: childReading.exe,
              argv: childReading.argv,
            },
          });
        }
      }
    }

    async function waitUntilReady(metricsPort: number): Promise<string> {
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        throwIfAborted();
        if (end) {
          throw new CloudflaredLaunchError(end.error ? "unavailable" : classifyFailure(recent, "exit"), tail(recent));
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new CloudflaredLaunchError(classifyFailure(recent, "deadline"), tail(recent));
        const [quick, edge] = await Promise.all([
          probeLoopback(metricsPort, "/quicktunnel"),
          probeLoopback(metricsPort, "/ready"),
        ]);
        if (edge.status === 200) {
          const host = hostnameFromQuickTunnel(quick.body) ?? logHost;
          if (host) return `https://${host}`;
        }
        await Promise.race([sleep(Math.min(pollIntervalMs, remaining)), childEnd.promise, aborted]);
      }
    }

    async function terminateChild(): Promise<void> {
      if (!child || end) return;
      selfKilled = true;
      child.kill("SIGTERM");
      if (await settledWithin(childEnd.promise, stopGraceMs)) return;
      child.kill("SIGKILL");
      await settledWithin(childEnd.promise, KILL_WAIT_MS);
    }

    async function removeResources(): Promise<void> {
      for (const path of [homePath, recordPath, recordPath && `${recordPath}.tmp`]) {
        if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
      }
      liveRuns.delete(live);
    }

    const done = (async () => {
      try {
        const { binary, stateDir } = await prepare();
        throwIfAborted();
        const metricsPort = await reserveLoopbackPort();
        throwIfAborted();
        await begin(binary, stateDir, metricsPort);
        throwIfAborted();
        ready.resolve({ url: await waitUntilReady(metricsPort) });
        await Promise.race([childEnd.promise, aborted]);
        if (end && !stopRequested && !selfKilled) {
          exited.resolve({ code: end.code, signal: end.signal, stderrTail: tail(stderrLines) });
        }
      } catch (error) {
        ready.reject(
          error instanceof CloudflaredLaunchError
            ? error
            : new CloudflaredLaunchError("unavailable", tail(recent), undefined, error),
        );
      } finally {
        await terminateChild();
        await removeResources();
      }
      // 待たれない done の失敗で unhandled rejection にしない。起動の失敗は ready に載せ済み
    })().catch(() => {});

    return {
      ready: ready.promise,
      exited: exited.promise,
      stop() {
        stopRequested = true;
        abort.abort();
        return done;
      },
    };
  }

  return { availability, launch, sweepOrphans };
}
