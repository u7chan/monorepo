/**
 * BFF が子プロセスを起こす唯一の例外 (lint の許可もここと sandbox/ だけ)。
 * 契約と採らなかった案は docs/service-tunnel.md を参照する。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { agentWritableRoots, isInsideAny } from "./agent-write-roots";
import { acquireFileLock, fileLockHeld, type FileLock } from "./file-lock";
import { openProcessRef as openSystemProcessRef, type ProcessRef, type SignalOutcome } from "./pidfd";
import { processStartedAtMs } from "./proc-stat";
import { resolveTrustedExecutable } from "./sandbox/runtime-info";

export type { SignalOutcome };

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
const STALE_TMP_MS = 60_000;
/** 子の識別情報を読むまでの上限。停止・期限とは別に、記録を完成させるために待つ */
const IDENTITY_WAIT_MS = 2_000;
/** exit のあと、出力を読み切る (close を待つ) 上限 */
const DRAIN_MS = 500;
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
  | "store_unusable"
  | "proc_unavailable"
  | "lock_unavailable";

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

  const platform = input.platform ?? process.platform;
  if (platform !== "linux") return unavailable("unsupported_platform");
  if (!input.sessionStoreDir) return unavailable("store_missing");

  const binary = explicit
    ? realExecutable(explicit)
    : resolveTrustedExecutable(BINARY_NAME, input.trustedDirs ?? [CLOUDFLARED_IMAGE_DIR, cloudflaredDevDir(home)]);
  if (!binary) return unavailable("binary_missing");

  const writableRoots = agentWritableRoots({ rootCwd: input.rootCwd, home, fixed: input.writeRoots });
  if (isInsideAny(writableRoots, binary)) return unavailable("binary_in_write_root");

  let realStore: string;
  try {
    realStore = realpathSync(input.sessionStoreDir);
  } catch {
    return unavailable("store_missing");
  }
  const named = join(realStore, STATE_DIR_NAME);
  let stateDir = named;
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(named);
  } catch (error) {
    // 未作成は、起動のときに作る
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable("store_unusable");
  }
  if (entry) {
    try {
      stateDir = realpathSync(named);
    } catch {
      return unavailable("store_unusable");
    }
    if (isInsideAny(writableRoots, stateDir)) return unavailable("store_in_write_root");
    if (!entry.isDirectory()) return unavailable("store_unusable");
  }
  if (isInsideAny(writableRoots, realStore)) return unavailable("store_in_write_root");
  return { available: true, binary, stateDir };
}

export function cloudflaredUnavailableMessage(reason: CloudflaredUnavailableReason): string {
  switch (reason) {
    case "unsupported_platform":
      return "一時共有は Linux で使えます (Windows と macOS は対象外です)";
    case "binary_missing":
      return "cloudflared が見つかりません (イメージに同梱、dev は pnpm dev が配置、または PI_CLOUDFLARED_PATH で指定)";
    case "binary_in_write_root":
      return "cloudflared の実体がエージェントの書き込める場所にあるため、使えません";
    case "store_missing":
      return "会話ストアが無い構成では使えません (PI_SESSION_STORE を確認してください)";
    case "store_in_write_root":
      return "会話ストアがエージェントの書き込める場所にあるため、使えません";
    case "store_unusable":
      return "会話ストアの一時共有の作業場所 (tunnel/) をディレクトリとして使えません";
    case "proc_unavailable":
      return "プロセスの観測 (/proc) ができないため、一時共有を起動できません";
    case "lock_unavailable":
      return "起動元の生存を確かめるロックを取れないため、一時共有を起動できません";
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
  /** 止められなかった子の数。記録と専用 HOME は残し、次の起動の掃除が再び試す */
  failed: number;
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
  | { state: "present"; startedAtMs: number; exe: string; argv: string[]; cwd: string };

export type ListenerOwner = "yes" | "no" | "unknown";

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
  /** テスト用の差し替え。既定は pidfd (掴めない環境では何も送らない) */
  openProcessRef?: (pid: number) => Promise<ProcessRef | undefined>;
  /** テスト用の差し替え。既定は起動元の flock が生きているかを見る */
  lockHeld?: (path: string) => Promise<"held" | "free" | "unknown">;
  /** テスト用の差し替え。既定は fs の readFile (記録の読み取り失敗を注入する) */
  readRecordFile?: (path: string) => Promise<string>;
  /** テスト用の差し替え。既定は fs の readdir (一覧の読み取り失敗を注入する) */
  readStateDir?: (path: string) => Promise<string[]>;
  /** テスト用の差し替え。既定は fs の mkdir (書き込みの遅れを注入する) */
  mkdir?: typeof mkdir;
  /** テスト用の差し替え。既定は flock の取得 */
  acquireLock?: typeof acquireFileLock;
  /** テスト用の差し替え。既定は記録の書き込み */
  writeRecordFile?: (path: string, text: string) => Promise<void>;
  listenerOwner?: (pid: number, port: number) => Promise<ListenerOwner>;
  deadlineMs?: number;
  stopGraceMs?: number;
  killWaitMs?: number;
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

interface Probe {
  status: number;
  body: string;
  /** 本文を最後まで受けた。途中で切れた応答や上限を超えた応答は採らない */
  complete: boolean;
}

function probeLoopback(port: number, path: string, signal: AbortSignal): Promise<Probe> {
  return new Promise((settle) => {
    let done = false;
    const finish = (status: number, body: string, complete: boolean): void => {
      if (done) return;
      done = true;
      settle({ status, body, complete });
    };
    // fetch は env のプロキシ設定に従い得るので、loopback は http で直接引く
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", agent: false, signal, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = "";
        let complete = true;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_PROBE_BODY_CHARS) {
            complete = false;
            res.destroy();
          }
        });
        res.on("end", () => finish(res.statusCode ?? 0, body, complete));
        res.on("close", () => finish(res.statusCode ?? 0, body, false));
        res.on("error", () => finish(0, "", false));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(0, "", false);
    });
    req.on("error", () => finish(0, "", false));
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
export async function readProcessReading(pid: number): Promise<ProcessReading> {
  try {
    const startedAtMs = await processStartedAtMs(pid);
    if (startedAtMs === undefined) return { state: "gone" };
    if (startedAtMs === 0) return { state: "unknown" };
    let exe: string;
    let cmdline: string;
    let cwd: string;
    try {
      [exe, cmdline, cwd] = await Promise.all([
        readlink(`/proc/${pid}/exe`),
        readFile(`/proc/${pid}/cmdline`, "utf8"),
        readlink(`/proc/${pid}/cwd`),
      ]);
    } catch {
      // stat で生存を確かめたあとの読み取り失敗。主スレッドの終了後は exe を読めないことがあるので、不在と混ぜない
      return { state: "unknown" };
    }
    return { state: "present", startedAtMs, exe, argv: cmdline.split("\0").slice(0, -1), cwd };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "gone" } : { state: "unknown" };
  }
}

/**
 * メトリクスの待受が、起動した子自身のものか。別のプロセスが先にポートを取ると、その応答を子のものと取り違えるため。
 * `/proc/net/tcp` の IPv4 loopback の LISTEN の inode が子の fd にあるかで見る (cmdline から誰でもポートを読める)。
 * 同じアドレスとポートの LISTEN が 2 つ以上あると、繋ぎ先がどちらか決められないので採らない。
 */
export async function loopbackListenerOwner(pid: number, port: number, procRoot = "/proc"): Promise<ListenerOwner> {
  const wanted = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  let table: string;
  try {
    table = await readFile(join(procRoot, "net", "tcp"), "utf8");
  } catch (error) {
    // /proc の無い環境は確かめようが無い。有るのに読めないときは、確かめられないので採らない
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unknown" : "no";
  }
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    // probe は 127.0.0.1 へ繋ぐ。同じポートの IPv6 や別のアドレスの待受は、繋ぎ先ではない
    if (fields[3] === "0A" && fields[1] === wanted && fields[9]) inodes.add(fields[9]);
  }
  if (inodes.size !== 1) return "no";
  const fdDir = join(procRoot, String(pid), "fd");
  let fds: string[];
  try {
    fds = await readdir(fdDir);
  } catch {
    return "no";
  }
  for (const fd of fds) {
    const target = await readlink(join(fdDir, fd)).catch(() => "");
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode && inodes.has(inode)) return "yes";
  }
  return "no";
}

const RECORD_FILE = /^pid-\d{1,5}-[0-9a-f]{8}\.json$/;
const TMP_FILE = /^pid-\d{1,5}-[0-9a-f]{8}\.json\.tmp$/;
const HOME_DIR = /^home-\d{1,5}-[0-9a-f]{8}$/;

/** 記録の専用 HOME は、記録の名前から決まる (`pid-<port>-<id>.json` → `home-<port>-<id>`) */
const homeNameOf = (recordFile: string): string => recordFile.replace(/^pid-/, "home-").replace(/\.json$/, "");

const recordSchema = z.object({
  version: z.literal(1),
  owner: z.object({ pid: z.number().int().positive(), startedAtMs: z.number().int().nonnegative() }),
  home: z.string(),
  /** 子を起こし始めたが、識別情報をまだ確定していない。child も pendingChild も無いことがある */
  spawnPending: z.boolean().optional(),
  /** 確定した子。起動時刻まで揃ったものだけを入れ、照合では必ず比べる */
  child: z
    .object({
      pid: z.number().int().positive(),
      startedAtMs: z.number().int().nonnegative(),
      exe: z.string().min(1),
      argv: z.array(z.string()).max(32),
    })
    .nullable(),
  /** spawn したが、起動時刻を確定できていない子。送信の根拠にはせず、記録を残すためだけに持つ */
  pendingChild: z
    .object({
      pid: z.number().int().positive(),
      exe: z.string().min(1),
      argv: z.array(z.string()).max(32),
    })
    .nullable()
    .optional(),
});
type LaunchRecord = z.infer<typeof recordSchema>;

type RecordRead =
  | { kind: "ok"; record: LaunchRecord }
  | { kind: "corrupt" }
  | { kind: "unreadable" }
  | { kind: "gone" };

async function readRecord(path: string, readText: (path: string) => Promise<string>): Promise<RecordRead> {
  let text: string;
  try {
    text = await readText(path);
  } catch (error) {
    // 読めないだけでは、壊れているとは言えない。消すと、次の掃除が見つけられなくなる
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "gone" } : { kind: "unreadable" };
  }
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: "ok", record: parsed.data } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

async function writeRecord(
  path: string,
  record: LaunchRecord,
  writeText: (path: string, text: string) => Promise<void>,
): Promise<void> {
  const partial = `${path}.tmp`;
  await writeText(partial, JSON.stringify(record));
  await rename(partial, path);
}

function hasFixedTunnelArgs(argv: readonly string[]): boolean {
  const metrics = /^127\.0\.0\.1:(\d{1,5})$/.exec(argv[6] ?? "")?.[1];
  const origin = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(argv[10] ?? "")?.[1];
  if (!metrics || !origin) return false;
  const expected = cloudflaredArgs({ metricsPort: Number(metrics), originPort: Number(origin) });
  return argv.length === expected.length + 1 && expected.every((arg, index) => argv[index + 1] === arg);
}

type ReadProcess = (pid: number) => Promise<ProcessReading>;
type OpenProcessRef = (pid: number) => Promise<ProcessRef | undefined>;
type RecordedChild = NonNullable<LaunchRecord["child"]>;
type PendingChild = NonNullable<LaunchRecord["pendingChild"]>;

async function ownerIsAlive(owner: LaunchRecord["owner"], readProcess: ReadProcess): Promise<boolean> {
  const reading = await readProcess(owner.pid);
  if (reading.state === "gone") return false;
  if (reading.state === "unknown") return true;
  // pid が別のプロセスに再利用されていれば、起動時刻が違う
  return reading.startedAtMs === owner.startedAtMs;
}

/** same: 記録どおりの孤児 / changed: 居ない・別のプロセス / unknown: 観測できない / parented: 生きている起動元の子 */
type ChildCheck = "same" | "changed" | "unknown" | "parented";

/**
 * 記録の写しだけを根拠にしない。書き換えた記録で他のプロセスを殺せるため、/proc の実物で全項目を照合する。
 * 起動元が生きているかは、起動元が持つ flock で見る (ppid は PID 1 や subreaper と区別できない)。
 */
async function checkRecordedChild(
  child: RecordedChild,
  expected: { binary: string; cwd: string; lockPath: string },
  readProcess: ReadProcess,
  lockHeld: (path: string) => Promise<"held" | "free" | "unknown">,
): Promise<ChildCheck> {
  const reading = await readProcess(child.pid);
  if (reading.state === "unknown") return "unknown";
  if (reading.state === "gone") return "changed";
  const matches =
    reading.startedAtMs === child.startedAtMs &&
    reading.exe === child.exe &&
    child.exe === expected.binary &&
    reading.cwd === expected.cwd &&
    reading.argv.length === child.argv.length &&
    reading.argv.every((arg, index) => arg === child.argv[index]) &&
    hasFixedTunnelArgs(reading.argv);
  if (!matches) return "changed";
  const held = await lockHeld(expected.lockPath);
  if (held === "unknown") return "unknown";
  // 起動元のロックが生きていれば孤児ではない。外れていれば、subreaper に引き取られていても孤児
  return held === "held" ? "parented" : "same";
}

/** `same` でなくなる (終わった・別のプロセスに変わった・観測できない) まで待つ */
async function waitUntilStopped(
  check: () => Promise<ChildCheck>,
  ms: number,
): Promise<"stopped" | "unknown" | "still"> {
  const until = Date.now() + ms;
  for (;;) {
    const state = await check();
    if (state === "changed") return "stopped";
    if (state !== "same") return "unknown";
    if (Date.now() >= until) return "still";
    await sleep(Math.min(SWEEP_POLL_MS, Math.max(1, until - Date.now())));
  }
}

type TerminateOutcome = "stopped" | "gone" | "changed" | "survived" | "unknown";

/**
 * 照合のあとに pidfd を開き、開いた直後にもう一度照合する。以降の signal は掴んだ参照へ送るので、
 * 送る直前に pid が再利用されても別のプロセスへは届かない。掴めない環境では送らない。
 */
async function terminateRecordedChild(
  pid: number,
  check: () => Promise<ChildCheck>,
  openRef: OpenProcessRef,
  waitMs: number,
): Promise<TerminateOutcome> {
  const ref = await openRef(pid);
  if (!ref) return "unknown";
  try {
    const before = await check();
    if (before === "changed") return "changed";
    if (before !== "same") return "unknown";
    const term = ref.send("SIGTERM");
    if (term === "gone") return "gone";
    if (term === "denied") return "survived";
    const first = await waitUntilStopped(check, waitMs);
    if (first !== "still") return first;
    const kill = ref.send("SIGKILL");
    if (kill === "gone") return "stopped";
    if (kill === "denied") return "survived";
    const second = await waitUntilStopped(check, waitMs);
    return second === "still" ? "survived" : second;
  } finally {
    ref.close();
  }
}

interface SweepContext {
  stateDir: string;
  binary: string;
  readProcess: ReadProcess;
  openProcessRef: OpenProcessRef;
  lockHeld: (path: string) => Promise<"held" | "free" | "unknown">;
  readText: (path: string) => Promise<string>;
  readDir: (path: string) => Promise<string[]>;
  waitMs: number;
}

async function sweepStateDir(ctx: SweepContext): Promise<CloudflaredSweepReport> {
  const { stateDir, readProcess } = ctx;
  const report: CloudflaredSweepReport = { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 };
  const self = await readProcess(process.pid);
  // /proc を読めない環境では、生きている BFF の HOME と見分けられないので、何も殺さず何も消さない
  if (self.state !== "present") return report;

  // 一覧の読み取りに失敗したら、空とみなして HOME を消さない。記録は残ったまま HOME だけ消えるのを避ける
  let homes: string[];
  let names: string[];
  try {
    // HOME の一覧は記録の一覧より先に取る。記録は HOME より先に書かれるので、この一覧に載る HOME の記録は次の一覧に必ず出る
    homes = (await ctx.readDir(stateDir)).filter((name) => HOME_DIR.test(name));
    names = await ctx.readDir(stateDir);
  } catch {
    return report;
  }

  // 書いた BFF が生きているあいだは、その HOME も子も他のインスタンスのもの
  const keep = new Set<string>();
  const orphaned: Array<{ path: string; home: string; record: LaunchRecord | undefined }> = [];
  for (const name of names.filter((entry) => RECORD_FILE.test(entry)).sort()) {
    const path = join(stateDir, name);
    const home = homeNameOf(name);
    const read = await readRecord(path, ctx.readText);
    if (read.kind === "gone") continue;
    if (read.kind === "unreadable") {
      keep.add(home);
      continue;
    }
    // 中身が読めても、起動元のロックが生きている・確かめられないうちは、記録も HOME も触らない。
    // HOME が無ければロックも無いので、残っている記録だけを消す
    const homeExists = await stat(join(stateDir, home)).then(
      () => true,
      () => false,
    );
    const held = homeExists ? await ctx.lockHeld(join(stateDir, home, "launch.lock")) : "free";
    if (held !== "free") {
      keep.add(home);
      continue;
    }
    // 中身の home は信じない。他の場所を cwd に持つ子を指せてしまう
    const record = read.kind === "ok" && read.record.home === home ? read.record : undefined;
    if (record && (await ownerIsAlive(record.owner, readProcess))) keep.add(home);
    else orphaned.push({ path, home, record });
  }

  for (const { path, home, record } of orphaned) {
    let settled = true;
    const child = record?.child;
    if (child) {
      const expected = { binary: ctx.binary, cwd: join(stateDir, home), lockPath: join(stateDir, home, "launch.lock") };
      const check = (): Promise<ChildCheck> => checkRecordedChild(child, expected, readProcess, ctx.lockHeld);
      const first = await check();
      if (first === "same") {
        const outcome = await terminateRecordedChild(child.pid, check, ctx.openProcessRef, ctx.waitMs);
        if (outcome === "stopped") report.killed += 1;
        // 止められたと確かめられない子の記録を消すと、次の掃除が見つけられなくなる
        if (outcome === "survived" || outcome === "unknown") {
          settled = false;
          report.failed += 1;
        }
      } else if (first === "unknown") {
        settled = false;
        report.failed += 1;
      } else if (first === "parented") {
        settled = false;
      }
    } else if (record?.spawnPending || record?.pendingChild) {
      // 子の識別情報を確定できない記録。子が居るかもしれないので、何も消さない
      settled = false;
      report.failed += 1;
    }
    if (!settled) {
      keep.add(home);
      continue;
    }
    await rm(path, { force: true });
    report.removedRecords += 1;
  }

  // 記録を消したあとの専用 HOME と、SIGKILL で残った HOME。会話ストアは永続ボリュームのことがあり、放置すると溜まる
  for (const name of homes) {
    if (keep.has(name)) continue;
    // 記録が壊れていても、その HOME のロックが生きている・確かめられないなら消さない
    if ((await ctx.lockHeld(join(stateDir, name, "launch.lock"))) !== "free") continue;
    await rm(join(stateDir, name), { recursive: true, force: true });
    report.removedHomes += 1;
  }

  // 書いている最中に止まった記録。新しいものは、並行して起動した BFF が書いている最中かもしれないので残す
  for (const name of names.filter((entry) => TMP_FILE.test(entry))) {
    const info = await stat(join(stateDir, name)).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > STALE_TMP_MS) await rm(join(stateDir, name), { force: true });
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
  const openProcessRef = options.openProcessRef ?? openSystemProcessRef;
  const lockHeld = options.lockHeld ?? fileLockHeld;
  const readText = options.readRecordFile ?? ((path: string) => readFile(path, "utf8"));
  const readDir = options.readStateDir ?? readdir;
  const makeDir = options.mkdir ?? mkdir;
  const takeLock = options.acquireLock ?? acquireFileLock;
  const writeRecordText =
    options.writeRecordFile ?? ((path: string, text: string) => writeFile(path, text, { mode: 0o600 }));
  const listenerOwner = options.listenerOwner ?? loopbackListenerOwner;
  const deadlineMs = options.deadlineMs ?? CLOUDFLARED_READY_DEADLINE_MS;
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const sweepTermWaitMs = options.sweepTermWaitMs ?? SWEEP_TERM_WAIT_MS;

  const availability = (): CloudflaredResolution => resolveCloudflared({ ...options, home });

  let sweeping: Promise<CloudflaredSweepReport> | undefined;
  const sweepOrphans = (): Promise<CloudflaredSweepReport> =>
    (sweeping ??= (async () => {
      const resolution = availability();
      const empty: CloudflaredSweepReport = { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 };
      if (!resolution.available) return empty;
      try {
        const report = await sweepStateDir({
          stateDir: resolution.stateDir,
          binary: resolution.binary,
          readProcess,
          openProcessRef,
          lockHeld,
          readText,
          readDir,
          waitMs: sweepTermWaitMs,
        });
        if (report.killed > 0) log(`tunnel: stopped ${report.killed} leftover cloudflared process(es)`);
        if (report.failed > 0) log(`tunnel: could not stop ${report.failed} leftover cloudflared process(es)`);
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
    // 期限は launch() からの 1 本。単調時計で見る (壁時計の調整で伸び縮みさせない)
    const deadlineAt = performance.now() + deadlineMs;
    const expired = (): boolean => performance.now() >= deadlineAt;
    const stopOrDeadline = AbortSignal.any([abort.signal, AbortSignal.timeout(deadlineMs)]);
    const exitAbort = new AbortController();
    const probeSignal = AbortSignal.any([stopOrDeadline, exitAbort.signal]);
    const ready = deferred<{ url: string }>();
    const exited = deferred<CloudflaredExit>();
    // 呼び出し側が待たない失敗 (stop() で中断した後など) で unhandled rejection にしない
    ready.promise.catch(() => {});

    let stopRequested = false;
    let selfKilled = false;
    let child: ChildProcess | undefined;
    // プロセスが終わった印 (exit か起動の失敗)。close は出力を読み切った後で、これより遅れ得るので別に持つ
    let gone: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;
    const childGone = deferred<void>();
    const childClosed = deferred<void>();
    const recent: string[] = [];
    const stderrLines: string[] = [];
    let logHost: string | undefined;
    let homePath: string | undefined;
    let recordPath: string | undefined;
    let launchLock: FileLock | undefined;
    let terminating: Promise<void> | undefined;

    const tail = (lines: readonly string[]): string => maskTunnelHostnames(lines.slice(-TAIL_LINES).join("\n"));
    const failure = (kind: CloudflaredFailureKind): CloudflaredLaunchError =>
      new CloudflaredLaunchError(kind, tail(recent));
    const stopFailure = (): CloudflaredLaunchError =>
      failure(abort.signal.aborted ? "aborted" : classifyFailure(recent, "deadline"));
    const throwIfStopped = (): void => {
      // タイマーの通知はイベントループが遅れると遅れる。子を起こす前は時計を同期で見る
      if (stopOrDeadline.aborted || expired()) throw stopFailure();
    };
    /** 待つ作業そのものは止められないが、停止・期限のあとは、その先 (子を起こすなど) へ進まない */
    const guarded = <T>(work: Promise<T>): Promise<T> =>
      new Promise<T>((resolveWork, rejectWork) => {
        const onStop = (): void => rejectWork(stopFailure());
        if (stopOrDeadline.aborted) {
          work.catch(() => {});
          onStop();
          return;
        }
        stopOrDeadline.addEventListener("abort", onStop, { once: true });
        work.then(resolveWork, rejectWork).finally(() => stopOrDeadline.removeEventListener("abort", onStop));
      });
    const markGone = (info: NonNullable<typeof gone>): void => {
      gone ??= info;
      exitAbort.abort();
      childGone.resolve();
    };

    // 停止・期限は、書き込みや mkdir が終わるのを待たずに ready を落とす。後片付けは本体の順序で続ける
    const rejectReady = (): void => {
      ready.reject(stopFailure());
    };
    if (stopOrDeadline.aborted) rejectReady();
    else stopOrDeadline.addEventListener("abort", rejectReady, { once: true });

    const live: LiveRun = {
      killSync() {
        // 記録と専用 HOME は消さない。止められたと確かめる時間が無いので、次の掃除に任せる
        try {
          child?.kill("SIGKILL");
        } catch {
          // 既に終了している
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
      await guarded(sweepOrphans());
      throwIfStopped();
      // 起動のたびに、バイナリと置き場がエージェントの書けない場所のままであることを確かめ直す
      const resolution = availability();
      if (!resolution.available) throw new CloudflaredLaunchError("unavailable", "", resolution.reason);
      try {
        await makeDir(resolution.stateDir, { recursive: true, mode: 0o700 });
        await chmod(resolution.stateDir, 0o700);
      } catch {
        throw new CloudflaredLaunchError("unavailable", "", "store_unusable");
      }
      throwIfStopped();
      return resolution;
    }

    async function begin(binary: string, stateDir: string, metricsPort: number): Promise<void> {
      const id = randomBytes(4).toString("hex");
      const homeName = `home-${options.instancePort}-${id}`;
      const ownerReading = await guarded(readProcess(process.pid));
      // 自分を観測できないまま記録なしで起動すると、別の BFF の掃除に、稼働中の専用 HOME を消される
      if (ownerReading.state !== "present") throw new CloudflaredLaunchError("unavailable", "", "proc_unavailable");
      const owner = { pid: process.pid, startedAtMs: ownerReading.startedAtMs };
      // 記録は専用 HOME より先に書く。記録の無い HOME が生きている起動のものだと取り違えないため
      recordPath = join(stateDir, `pid-${options.instancePort}-${id}.json`);
      await writeRecord(
        recordPath,
        { version: 1, owner, home: homeName, spawnPending: true, child: null },
        writeRecordText,
      );
      throwIfStopped();
      homePath = join(stateDir, homeName);
      liveRuns.add(live);
      await makeDir(homePath, { mode: 0o700 });
      launchLock = await takeLock(join(homePath, "launch.lock"));
      // ロックが無いと、起動元が生きていることを掃除側が確かめられない
      if (!launchLock) throw new CloudflaredLaunchError("unavailable", "", "lock_unavailable");
      // この確認の直後に起こす。停止・期限のあとに子を起こさない
      throwIfStopped();

      const args = cloudflaredArgs({ metricsPort, originPort });
      const spawned = spawnChild(binary, args, {
        env: childEnv(options.env, homePath),
        cwd: homePath,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child = spawned;
      const stdout = lineCollector(onLine("stdout"));
      const stderr = lineCollector(onLine("stderr"));
      spawned.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      spawned.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      spawned.once("exit", (code, signal) => markGone({ code, signal }));
      spawned.once("close", (code, signal) => {
        stdout.end();
        stderr.end();
        markGone({ code, signal });
        childClosed.resolve();
      });
      spawned.on("error", (error) => {
        // 起動の失敗には pid が無い。kill の失敗 (EPERM など) では子が生きているので、終わったとは扱わない
        if (spawned.pid !== undefined) return;
        markGone({ code: null, signal: null, error });
        childClosed.resolve();
      });

      if (!recordPath || spawned.pid === undefined) return;
      const pendingChild: PendingChild = { pid: spawned.pid, exe: binary, argv: [binary, ...args] };
      // spawn の直後に書く。ここで BFF が落ちても、子が居たことは記録に残る
      await writeRecord(recordPath, { version: 1, owner, home: homeName, child: null, pendingChild }, writeRecordText);
      // 停止・期限では打ち切らず、記録の確定だけは独立に待つ (未確定の子を「子なし」と混ぜない)
      const reading = readProcess(spawned.pid).catch((): ProcessReading => ({ state: "unknown" }));
      const childReading = (await settledWithin(reading, IDENTITY_WAIT_MS))
        ? await reading
        : { state: "unknown" as const };
      if (childReading.state !== "present") {
        // 起動時刻まで確定できない子は成功にも送信にも使わない。記録は pendingChild のまま残す
        throw new CloudflaredLaunchError("unavailable", "", "proc_unavailable");
      }
      await writeRecord(
        recordPath,
        {
          version: 1,
          owner,
          home: homeName,
          child: {
            pid: spawned.pid,
            startedAtMs: childReading.startedAtMs,
            exe: childReading.exe,
            argv: childReading.argv,
          },
        },
        writeRecordText,
      );
    }

    async function exitFailure(): Promise<CloudflaredLaunchError> {
      // exit は close より先に届く。出力を読み切ってから分類する
      await settledWithin(childClosed.promise, DRAIN_MS);
      return new CloudflaredLaunchError(gone?.error ? "unavailable" : classifyFailure(recent, "exit"), tail(recent));
    }

    // 停止・子の終了・期限は、probe の応答より優先する。応答を待つ間に起きていても、成功で上書きしない
    async function checkpoint(): Promise<void> {
      if (abort.signal.aborted) throw failure("aborted");
      if (gone) throw await exitFailure();
      if (expired()) throw failure(classifyFailure(recent, "deadline"));
    }

    async function waitUntilReady(metricsPort: number): Promise<string> {
      // 待受が子自身のものと確かめられるまで、その応答を採らない。確認できない (unknown) も採らない
      const owns = async (): Promise<boolean> =>
        child?.pid !== undefined && (await guarded(listenerOwner(child.pid, metricsPort))) === "yes";
      for (;;) {
        await checkpoint();
        if (await owns()) {
          const [quick, edge] = await Promise.all([
            probeLoopback(metricsPort, "/quicktunnel", probeSignal),
            probeLoopback(metricsPort, "/ready", probeSignal),
          ]);
          await checkpoint();
          if (edge.status === 200) {
            const host =
              (quick.status === 200 && quick.complete ? hostnameFromQuickTunnel(quick.body) : undefined) ?? logHost;
            // 採る直前にも、待受が子のものであること・停止・終了・期限を確かめる
            if (host && (await owns())) {
              await checkpoint();
              return `https://${host}`;
            }
          }
        }
        const remaining = Math.max(1, deadlineAt - performance.now());
        await Promise.race([sleep(Math.min(pollIntervalMs, remaining)), childGone.promise, aborted]);
      }
    }

    function terminateChild(): Promise<void> {
      // 記録の書き込み待ちで停止が遅れないよう、停止・期限の通知からも並行して呼ぶ
      return (terminating ??= (async () => {
        if (!child || gone) return;
        selfKilled = true;
        child.kill("SIGTERM");
        if (await settledWithin(childGone.promise, stopGraceMs)) return;
        child.kill("SIGKILL");
        await settledWithin(childGone.promise, killWaitMs);
      })());
    }

    async function removeResources(): Promise<void> {
      // 止められなかった子の記録と専用 HOME を捨てると、次の掃除が見つけられなくなる。終わったときに消す
      if (child && !gone) {
        void childGone.promise.then(removeResources);
        return;
      }
      await launchLock?.release();
      launchLock = undefined;
      for (const path of [homePath, recordPath, recordPath && `${recordPath}.tmp`]) {
        if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
      }
      liveRuns.delete(live);
    }

    // 記録の rename が詰まっていても、停止・期限では子へ先に TERM を送る
    if (stopOrDeadline.aborted) void terminateChild();
    else stopOrDeadline.addEventListener("abort", () => void terminateChild(), { once: true });

    const done = (async () => {
      try {
        const { binary, stateDir } = await prepare();
        const metricsPort = await guarded(reserveLoopbackPort());
        throwIfStopped();
        await begin(binary, stateDir, metricsPort);
        throwIfStopped();
        const url = await waitUntilReady(metricsPort);
        // 応答を採る直後にも、期限と停止を見る
        throwIfStopped();
        ready.resolve({ url });
        await Promise.race([childGone.promise, aborted]);
        if (gone && !stopRequested && !selfKilled) {
          await settledWithin(childClosed.promise, DRAIN_MS);
          if (!stopRequested) exited.resolve({ code: gone.code, signal: gone.signal, stderrTail: tail(stderrLines) });
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
