/**
 * serve (UI 上の呼称は「サービス」) の状態と起動・停止。公開枠は全会話で共有の 1 本で、
 * 誰が動かしているかはサンドボックスの作業領域 (`<appdir>/serve/state.json`) の記録と
 * 「いま待受しているプロセス」の照合で決める。設計は docs/sandbox.md の serve の節を正とする。
 */
import { randomBytes, createHash } from "node:crypto";
import { createConnection } from "node:net";
import { SERVE_DIR_REL, SERVE_LOG_REL, SERVE_STATE_REL, serveDebugLogRel } from "./app-paths";
import type { ServeCommandRow } from "./app-db";
import { SANDBOX_NOT_CONFIGURED_MESSAGE, httpError } from "./http";
import { MutationLock } from "./model-settings";
// serve 契約の待受ポート。プローブも待受 PID の特定も、サービス オリジンの転送先もこの値だけを見る
import { SERVE_LISTEN_PORT } from "./preview-port";
import type { SandboxServeClient } from "./sandbox/client";
import type { SandboxListenerScan, SandboxWriteScopeEntry } from "./sandbox/protocol";
import type { RuntimeServeStatus } from "./schema";

/** 起動の成功境界。バックグラウンド起動の shell が終わってからこの期限までに到達可になること */
export const SERVE_START_TIMEOUT_MS = 10_000;
/** 停止後にポートの解放を確認する期限 */
export const SERVE_STOP_TIMEOUT_MS = 5_000;
/** 1 回の TCP connect の期限。4 秒のポーリングに乗るため短くする */
export const SERVE_PROBE_TIMEOUT_MS = 1_000;
/** 判定の使い回し。複数タブが同じ結果を使う。起動・停止の直後は必ず捨てる */
export const SERVE_STATUS_CACHE_MS = 2_000;
/** 期限つき待ちの再確認間隔 (到達不可の間は軽いプローブだけ) */
const SERVE_POLL_INTERVAL_MS = 250;
/** 到達可だがまだ自分のプロセスでないときの再確認間隔 (fd 走査を連打しない) */
const SERVE_OWN_LISTENER_INTERVAL_MS = 1_000;
/** サンドボックスの bash 実行に渡す期限 (秒)。待ちは BFF 側で行うため、スクリプト自体は短命 */ const SANDBOX_SCRIPT_TIMEOUT_SECONDS = 20;
/** スクリプトが最後に出す印。欠けていればサンドボックス側の失敗として扱う */
const SCRIPT_OK = "serve:ok";

/**
 * 内部実行が書き込める範囲 (root 相対)。起動したアプリも含め、作業ディレクトリと作業領域の外へは
 * 書かせない (`/tmp` とホームのキャッシュ、デバイスファイルはサンドボックスが全実行へ足す)。
 */
const SERVE_WRITE_SCOPE = [{ path: SERVE_DIR_REL }] as const;
/** 記録の書き込みと起動は作業領域を作ってから書くため、作成を許可する */
const SERVE_WRITE_SCOPE_CREATE = [{ path: SERVE_DIR_REL, create: true }] as const;

/**
 * デバッグ枠 (エージェントの自己検証だけが使う serve) のポートレンジ。4 桁 = ユーザーへ見せる公開枠、
 * 5 桁 = エージェント内部用、という境界を保つ。デプロイごとに変える値ではないため env にしない。
 */
export const DEBUG_SERVE_PORT_FROM = 18000;
export const DEBUG_SERVE_PORT_TO = 18099;

/** デバッグ枠の port か。追跡外の待受を停止させる要求の受け付け判定に使う */
export function isDebugServePort(port: number): boolean {
  return Number.isInteger(port) && port >= DEBUG_SERVE_PORT_FROM && port <= DEBUG_SERVE_PORT_TO;
}

/**
 * デバッグ用 serve の lease。BFF のメモリだけに持ち、再起動では復元しない (残った待受は追跡外になる)。
 * lease は「起動して待受を確認できた」ことを表し、照合の材料 (起動 PID / 待受 PID / 開始時刻 / inode) を持つ。
 */
export interface DebugServeLease {
  sessionId: string;
  port: number;
  command: string;
  /** 起動を試みた PID。起動由来 (この PID 自身か子孫) の照合に使う */
  launchPid: number;
  /** 起動時に特定した待受 PID とその開始時刻 (PID 再利用の照合) */
  pid: number;
  startedAt: number;
  /** 起動時に特定した待受ソケットの inode (昇順) */
  inodes: number[];
}

/** デバッグ用 serve の起動結果。ポートは起動のたびに変わり得るので、常に応答から受け取らせる */
export interface DebugServeHandle {
  port: number;
  command: string;
  logPath: string;
}

/** デバッグ用 serve の状態。待受の有無はレンジ走査の結果で、lease の存在だけでは待受と言わない */
export interface DebugServeStatus {
  lease: { port: number; command: string; logPath: string; listening: boolean } | null;
  /** lease を持たないレンジ内の待受 (BFF 再起動をまたいだ残骸など)。ポートだけ返す */
  untrackedPorts: number[];
}

/** デバッグ用 serve の停止結果。`alreadyStopped` は二重停止 (既に待受が無い) を表す */
export interface DebugServeStopResult {
  port: number | null;
  released: boolean;
  alreadyStopped: boolean;
}

/** 起動の検証を失敗させた理由 */
type DebugStartFailure = "timeout" | "other" | "non-loopback";

/** デバッグ用 serve を止めるときの理由文 (運用で読むのはログとこの 1 行) */
function debugStartFailureMessage(port: number, reason: DebugStartFailure, note: string | null): string {
  const detail =
    reason === "timeout"
      ? `期限内に 127.0.0.1:${port} の待受を確認できませんでした`
      : reason === "other"
        ? `127.0.0.1:${port} はこの起動に由来しないプロセスが使用しています`
        : `127.0.0.1:${port} はループバック以外へ bind しています (デバッグ用 serve は 127.0.0.1 だけで待ち受ける必要があります)`;
  return [
    `デバッグ用 serve の起動に失敗しました: ${detail}`,
    `ログ ${serveDebugLogRel(port)} を確認してください`,
    ...(note === null ? [] : [note]),
  ].join("。");
}

/** 待受のない lease を掃除する。プロセスだけ死んだ状態を次の操作で回収する */
function pruneDebugLeases(leases: Map<string, DebugServeLease>, livePorts: readonly number[]): void {
  const listening = new Set(livePorts);
  for (const [sessionId, lease] of leases) {
    if (!listening.has(lease.port)) leases.delete(sessionId);
  }
}

/** 待受プロセスが lease の起動に由来するか (起動 PID の子孫 / 待受 PID と開始時刻の一致) */
function matchesDebugLease(listener: ServeListener, lease: DebugServeLease): boolean {
  if (isFromLaunch(listener, lease.launchPid)) return true;
  return (
    listener.pid === lease.pid && listener.startedAt === lease.startedAt && sameInodes(listener.inodes, lease.inodes)
  );
}

export type ServeOwnerKind = "mine" | "other" | "unknown" | "none";

export interface ServeOwner {
  kind: ServeOwnerKind;
  /** `mine` / `other` のときだけ返す会話名 */
  title?: string;
}

export interface ServeCommand {
  /** ワークスペース root 相対の作業ディレクトリ */
  cwd: string;
  command: string;
}

export interface ServeStatus {
  /** プローブ (BFF → サンドボックス serve listen ポートの TCP connect) の結果 */
  reachable: boolean;
  owner: ServeOwner;
  /** 置き換えの再照合用。記録が無ければ null */
  generation: string | null;
  /** 閲覧中の会話の作業ディレクトリの成功実績。無ければ null (他会話の実績は返さない) */
  command: ServeCommand | null;
  /**
   * 起動時に解決した環境変数の世代 (記録と待受プロセスが一致するときだけ返す)。
   * 一覧 API の generation と比べると「再起動で反映される変更」が分かる。記録が無い / 不明は null
   */
  secretGeneration: string | null;
}

/** 全体で 1 つの live な稼働記録。サンドボックスの作業領域へ同じ内容を書く */
export interface ServeRecord {
  /** 所有者セッション id */
  sessionId: string;
  /** 起動時の作業ディレクトリ (root 相対) */
  cwd: string;
  command: string;
  /** 起動時の PID (起動を試みた事実。照合には inodes を使う) */
  pid: number;
  startedAt: number;
  /**
   * 起動時に特定した「いま待受しているプロセス」の待受ソケット inode (昇順)。
   * プロセスの同一性の照合はこれで行う (fd 走査を伴う PID の特定を待たずに判定できる)。
   * この項目を持たない古い記録だけは pid + 起動時刻で照合する。
   */
  inodes: number[];
  /** 起動のたびに変わる値 */
  generation: string;
  /**
   * 起動時に解決した環境変数 (作業環境 → 環境変数) の世代。この項目より前の版が書いた記録は ""
   */
  secretGeneration: string;
}

/** serve の起動時に渡す環境変数の解決元 (SecretService が構造的に満たす) */
export interface ServeEnvSource {
  resolveServiceEnv(cwd: string): {
    variables: Record<string, string>;
    secrets: Record<string, string>;
    generation: string;
  };
}

/** 会話 id から作業ディレクトリ・会話名・所属スペースを引く (SessionStore が実装する) */
export interface ServeSessionLookup {
  /** root 相対。未知の会話は undefined */
  workdirOfId(id: string): string | undefined;
  titleOfId(id: string): string | undefined;
  /** 所属スペース。未知の会話は undefined (起動元の会話のリンクの `?space=` に使う) */
  spaceOfId(id: string): string | undefined;
}

/** serve の起動実績 (作業ディレクトリ単位)。AppDb が構造的に満たす */
export interface ServeCommandStore {
  getServeCommand(cwd: string): ServeCommandRow | undefined;
  saveServeCommand(row: ServeCommandRow): void;
}

/** 1 回のプローブ。到達不可は false、BFF から届かない障害は例外 */
export type ServeProbe = () => Promise<boolean>;

/**
 * TCP 接続に渡すホスト。URL の `hostname` は IPv6 リテラルを角括弧付きで返す (`[::1]`) が、
 * `net.connect` は角括弧を名前解決の対象にするため `getaddrinfo ENOTFOUND [::1]` になる。
 * ソケットへは外して渡す (URL 表記では逆に角括弧が必要)。
 */
export function tcpHost(host: string): string {
  const text = host.trim();
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

/**
 * プローブ先のホスト。BFF とサンドボックスは別コンテナ / 別プロセスなので、`PI_SANDBOX_URL` の
 * ホストへ serve listen ポートで繋ぐ (ツール API のポートとは別)。解決できなければ undefined。
 * 返す値はソケットへ直接渡せる形 (IPv6 リテラルの角括弧は外す)。
 */
export function sandboxHostFromUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  try {
    const host = new URL(text).hostname;
    return host ? tcpHost(host) : undefined;
  } catch {
    return undefined;
  }
}

/** いま listen しているプロセス。ancestors は自身から親をたどった PID (起動との照合に使う) */
export interface ServeListener {
  pid: number;
  startedAt: number;
  /** このプロセスが待受しているソケットの inode (昇順)。記録の照合に使う */
  inodes: number[];
  ancestors: number[];
}

interface ServeObservation {
  reachable: boolean;
  record: ServeRecord | null;
  /** いま listen しているソケットの inode (昇順)。安い観測でも取れる */
  listenInodes: number[];
  /** いま listen しているプロセス。fd 走査をしたときだけ分かる */
  listener: ServeListener | null;
  at: number;
}

export interface ServeServiceOptions {
  appDb: ServeCommandStore;
  sessions: ServeSessionLookup;
  /** 未設定なら serve の API / ツールは 503 */
  sandbox: SandboxServeClient | null;
  /**
   * 起動時に渡す環境変数 (作業環境 → 環境変数)。解決に失敗したら起動しない
   * (平文へ落とす / 秘密なしで起動するのどちらもしない)。未指定は env 無しで起動する (テスト)
   */
  secretEnv?: ServeEnvSource;
  /** プローブ先のホスト。未指定は 127.0.0.1 (同一ホストのサンドボックス)。IPv6 リテラルは角括弧付きでもよい */
  sandboxHost?: string;
  listenPort?: number;
  /** テストで差し替えるプローブ。未指定は listenPort への TCP connect */
  probe?: ServeProbe;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  cacheMs?: number;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 待受していない (到達不可) と見なす接続エラー。名前解決や経路の失敗はサンドボックスの障害として区別する */
const NOT_LISTENING_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);

function tcpProbe(host: string, port: number, timeoutMs: number): ServeProbe {
  return () =>
    new Promise<boolean>((resolve, reject) => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        run();
      };
      socket.setTimeout(timeoutMs, () => finish(() => resolve(false)));
      socket.once("connect", () => finish(() => resolve(true)));
      socket.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        finish(() =>
          NOT_LISTENING_CODES.has(code)
            ? resolve(false)
            : reject(httpError(502, `サンドボックス (${host}:${port}) へ接続できません: ${messageFor(error)}`)),
        );
      });
    });
}

/** bash の結果は text ブロックの配列で返る。HTTP の応答本文を 1 つのテキストへ */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? text : "";
    })
    .join("");
}

/** サンドボックスへ渡す値は base64 で包む (コマンド文字列を shell へ素で埋めない) */
function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * 稼働記録を 1 行で読む。待受ソケットと PID の観測は service 本体 (`GET /v1/procs/listeners`) が行う:
 * bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めないため。
 * 重い fd 走査は `scan` のときだけ走らせ、状態表示は `/proc/net/tcp` の inode と記録の照合だけで分類する。
 */
function recordScript(): string {
  return `node --input-type=commonjs -e '${[
    'const fs = require("node:fs");',
    `try { console.log("record\\t" + fs.readFileSync("${SERVE_STATE_REL}", "utf8").trim()); } catch (error) {}`,
    "' || { echo 'serve: read failed' >&2; exit 1; }",
    `echo ${SCRIPT_OK}`,
  ].join("\n")}`;
}

/**
 * バックグラウンド起動。ログは指定されたパスへ出し、起動した PID を返す。
 * 作業ディレクトリも base64 で渡す (shell へ値を直接埋め込まない。パス中の `$` やバッククォートを評価させない)。
 * デバッグ用 serve はポートを持ち、起動コマンドは `--port $U7AGENT_DEBUG_PORT` のように参照する。
 */
function launchScript(input: { workdir: string; command: string; log: string; port?: number }): string {
  return `set -u
root=$PWD
dir="$root/.u7agent/serve"
mkdir -p "$dir" || { echo "serve: mkdir failed" >&2; exit 1; }
log="$root/${input.log}"
mkdir -p "$(dirname "$log")" || { echo "serve: mkdir failed" >&2; exit 1; }
: > "$log" || { echo "serve: cannot open the log" >&2; exit 1; }
${input.port === undefined ? "" : `export U7AGENT_DEBUG_PORT=${input.port}\n`}workdir=$(printf '%s' '${encode(input.workdir)}' | base64 -d) || exit 1
cd "$root/$workdir" || { echo "serve: cannot enter the working directory" >&2; exit 1; }
cmd=$(printf '%s' '${encode(input.command)}' | base64 -d) || exit 1
nohup bash -c "$cmd" > "$log" 2>&1 < /dev/null &
printf 'pid\\t%s\\n' "$!"
echo ${SCRIPT_OK}
`;
}

/** 記録の書き換え。作業領域の固定パスへ同じ内容を書く */
function writeRecordScript(record: ServeRecord): string {
  return `set -u
dir="$PWD/.u7agent/serve"
mkdir -p "$dir" || { echo "serve: mkdir failed" >&2; exit 1; }
printf '%s' '${encode(JSON.stringify(record))}' | base64 -d > "$dir/state.json" || { echo "serve: cannot write the record" >&2; exit 1; }
echo ${SCRIPT_OK}
`;
}

/** 停止済みの記録は残さない。実績 (app-db) とは別物なので消してよい */
function clearRecordScript(): string {
  return `set -u
rm -f "$PWD/${SERVE_STATE_REL}" || { echo "serve: cannot remove the record" >&2; exit 1; }
echo ${SCRIPT_OK}
`;
}

/** 停止。対象は常に「いま待受している PID」で、記録の PID ではない */
function killScript(pid: number): string {
  return `set -u
kill ${pid} 2>/dev/null || true
echo ${SCRIPT_OK}
`;
}

/** 記録の 1 行を読む。壊れた記録は「記録なし」として扱い、所有者とみなさない */
function parseRecord(raw: string): ServeRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { sessionId, cwd, command, pid, startedAt, inodes, generation, secretGeneration } = parsed as Record<
    string,
    unknown
  >;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof cwd !== "string") return null;
  if (typeof command !== "string" || command === "") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (typeof generation !== "string" || generation === "") return null;
  const parsedInodes = Array.isArray(inodes)
    ? inodes.filter((value): value is number => Number.isInteger(value) && value > 0).sort((a, b) => a - b)
    : [];
  return {
    sessionId,
    cwd,
    command,
    pid,
    startedAt,
    inodes: parsedInodes,
    generation,
    // この項目より前の版が書いた記録は「不明」として空文字にする (値ではなく記録の欠落を表す)
    secretGeneration: typeof secretGeneration === "string" ? secretGeneration : "",
  };
}

/**
 * 記録の出力と service 本体の観測を ServeObservation へ。印の確認は呼び出し側 (#run) が行う。
 * 待受ソケットと PID は service の走査結果をそのまま使い、bash 側の出力は記録だけを見る。
 */
function parseObservation(output: string, scan: SandboxListenerScan, at: number): Omit<ServeObservation, "reachable"> {
  let record: ServeRecord | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("record\t")) {
      record = parseRecord(line.slice("record\t".length));
    }
  }
  return { record, listenInodes: scan.inodes, listener: scan.listener, at };
}

/** 待受ソケットの inode が同じか。空同士は一致とみなさない (不明を同じ扱いにしない) */
function sameInodes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/** 到達した待受プロセスが今回の起動に由来するか (起動 PID 自身か、その子孫) */
export function isFromLaunch(listener: ServeListener, launchedPid: number): boolean {
  return listener.pid === launchedPid || listener.ancestors.includes(launchedPid);
}

export class ServeService {
  #db: ServeCommandStore;
  #sessions: ServeSessionLookup;
  #sandbox: SandboxServeClient | null;
  #secretEnv: ServeEnvSource | undefined;
  #probe: ServeProbe;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #listenPort: number;
  #startTimeoutMs: number;
  #stopTimeoutMs: number;
  #cacheMs: number;
  #lock = new MutationLock();
  #cached: ServeObservation | null = null;
  /** デバッグ用のロック。公開枠と共有しない (レンジ走査で公開の起動・停止を待たせない) */
  #debugLock = new MutationLock();
  #debugLeases = new Map<string, DebugServeLease>();

  constructor(options: ServeServiceOptions) {
    this.#db = options.appDb;
    this.#sessions = options.sessions;
    this.#sandbox = options.sandbox;
    this.#secretEnv = options.secretEnv;
    this.#listenPort = options.listenPort ?? SERVE_LISTEN_PORT;
    this.#probe =
      options.probe ?? tcpProbe(tcpHost(options.sandboxHost ?? "127.0.0.1"), this.#listenPort, SERVE_PROBE_TIMEOUT_MS);
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? sleep;
    this.#startTimeoutMs = options.startTimeoutMs ?? SERVE_START_TIMEOUT_MS;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? SERVE_STOP_TIMEOUT_MS;
    this.#cacheMs = options.cacheMs ?? SERVE_STATUS_CACHE_MS;
  }

  get configured(): boolean {
    return this.#sandbox !== null;
  }

  /** 閲覧中の会話から見た状態。プローブの失敗は 502 / 503 で返し、reachable: false へ丸めない */
  async status(sessionId: string): Promise<ServeStatus> {
    const view = this.#view(sessionId);
    return this.#compose(view, await this.#observe());
  }

  /**
   * 全体の稼働判定。`fresh` は状態のキャッシュを読まずに取り直す (削除の直前確認が、直前に起動した
   * サービスを見落とさないため)。設定 → ランタイムのポーリングは既定のキャッシュを使う。
   */
  async runtimeStatus(options: { fresh?: boolean } = {}): Promise<RuntimeServeStatus> {
    return this.#composeRuntime(await this.#observe(options));
  }

  /** 全体管理からの停止も会話の操作と同じロック・世代照合を通す。 */
  async runtimeStop(input: { generation: string }): Promise<RuntimeServeStatus> {
    return this.#lock.run(async () => {
      this.#cached = null;
      const before = await this.#observe({ fresh: true, scanPids: true });
      this.#assertGeneration(before, input.generation);
      await this.#stopListener(before);
      await this.#clearRecord();
      this.#cached = null;
      return this.#composeRuntime({
        reachable: false,
        record: null,
        listenInodes: [],
        listener: null,
        at: this.#now(),
      });
    });
  }

  /**
   * 起動。到達可なら所有者の有無に関わらず置き換える (所有者の確認は UI が取る)。
   * 成功境界は「バックグラウンド起動の shell が終わってから、期限つきでプローブが到達可になること」。
   */
  async start(sessionId: string, input: { command?: string; generation?: string | null } = {}): Promise<ServeStatus> {
    const view = this.#view(sessionId);
    const explicit = input.command?.trim();
    return this.#lock.run(async () => {
      this.#cached = null;
      // 実績の解決と検証は置き換えの停止より先に行う (コマンドが無いのに既存を止めない)
      const command = explicit || this.#db.getServeCommand(view.cwd)?.command;
      if (!command) throw httpError(400, "この作業ディレクトリには serve の実績がありません");
      const before = await this.#observe({ fresh: true, scanPids: true });
      if (before.reachable) {
        this.#assertGeneration(before, input.generation ?? null);
        // 置き換えは所有者を問わない (UI が所有者名を出して確認してから呼ぶ)
        await this.#stopListener(before);
      }
      const generation = randomBytes(4).toString("hex");
      // 値の解決は起動の直前に行う。失敗したら起動せず、部分適用もしない
      const env = this.#secretEnv?.resolveServiceEnv(view.cwd) ?? { variables: {}, secrets: {}, generation: "" };
      const pid = await this.#launch(view, command, { ...env.variables, ...env.secrets }, { log: SERVE_LOG_REL });
      // 失敗しても「起動を試みた事実」は残す。以前の成功コマンドは上書きしない
      let record: ServeRecord = {
        sessionId: view.sessionId,
        cwd: view.cwd,
        command,
        pid,
        startedAt: this.#now(),
        inodes: [],
        generation,
        secretGeneration: env.generation,
      };
      await this.#writeRecord(record);
      // 到達しただけでは成功としない。待受プロセスがこの起動に由来することまで確かめる
      // (期限超過した別の起動が遅れて listen した場合、それを今回の成功として記録しない)
      const waited = await this.#waitForOwnListener(pid);
      if (!waited.ok) {
        this.#cached = null;
        throw httpError(
          502,
          waited.reachable
            ? `serve を起動しましたが、${this.#listenPort} 番ポートはこの起動に由来しないプロセスが使用しています。エージェントに確認を依頼してください`
            : `serve を起動しましたが、期限内に ${this.#listenPort} 番ポートへ到達できませんでした。${SERVE_LOG_REL} のログを確認してください`,
        );
      }
      // 到達できたら「いま待受しているプロセス」を正として記録し直す (所有者の照合を効かせる)
      record = {
        ...record,
        pid: waited.listener.pid,
        startedAt: waited.listener.startedAt,
        inodes: [...waited.listener.inodes],
      };
      await this.#writeRecord(record);
      // 実績の更新は成功時だけ (失敗したコマンドで以前の成功を上書きしない)
      this.#db.saveServeCommand({ cwd: view.cwd, command, updatedAt: this.#now() });
      this.#cached = null;
      return this.#compose(view, await this.#observe());
    });
  }

  /**
   * 停止。所有者の会話だけが止められるが、起動元不明 (記録と一致しない / 記録なし) のときは誰でも止められる
   * (誰も止められないサーバーを残さないため)。停止後はプローブで解放を確認してから応答する。
   */
  async stop(sessionId: string, input: { generation?: string | null } = {}): Promise<ServeStatus> {
    const view = this.#view(sessionId);
    return this.#lock.run(async () => {
      this.#cached = null;
      const before = await this.#observe({ fresh: true, scanPids: true });
      if (!before.reachable) {
        // 到達不可なら止めるものが無い。記録だけ片付ける (停止済みとして扱う)
        if (before.record) await this.#clearRecord();
        this.#cached = null;
        return this.#compose(view, {
          reachable: false,
          record: null,
          listenInodes: [],
          listener: null,
          at: this.#now(),
        });
      }
      this.#assertGeneration(before, input.generation ?? null);
      const owner = this.#ownerOf(view, before);
      if (owner.kind === "other") {
        throw httpError(403, `このサービスは会話「${owner.title ?? ""}」が公開しています`);
      }
      await this.#stopListener(before);
      await this.#clearRecord();
      this.#cached = null;
      return this.#compose(view, { reachable: false, record: null, listenInodes: [], listener: null, at: this.#now() });
    });
  }

  /**
   * デバッグ用 serve の起動。公開枠とは別のロックの内側で、レンジ内の「lease が無く、待受も無い」
   * 最小ポートを採番し、127.0.0.1 のループバック待受を確認してから lease を置く。
   * 同じ会話の再起動は前のプロセスの停止と解放を確認してからでないと始めない (二重起動を作らない)。
   */
  async debugStart(sessionId: string, input: { command?: string } = {}): Promise<DebugServeHandle> {
    const view = this.#view(sessionId);
    const command = input.command?.trim();
    if (!command) throw httpError(400, "デバッグ用 serve の起動コマンドを指定してください");
    return this.#debugLock.run(async () => {
      await this.#releaseDebugLease(view.sessionId);
      const port = await this.#allocateDebugPort();
      const env = this.#secretEnv?.resolveServiceEnv(view.cwd) ?? { variables: {}, secrets: {}, generation: "" };
      const launchPid = await this.#launch(
        view,
        command,
        { ...env.variables, ...env.secrets },
        { log: serveDebugLogRel(port), port },
      );
      const waited = await this.#waitForDebugListener(port, launchPid);
      if (!waited.ok) {
        // 失敗しても起動を試みた事実はログにだけ残す (公開の稼働記録も実績も触らない)
        const note = await this.#abandonDebugStart(port, launchPid, waited.listener);
        throw httpError(502, debugStartFailureMessage(port, waited.reason, note));
      }
      const lease: DebugServeLease = {
        sessionId: view.sessionId,
        port,
        command,
        launchPid,
        pid: waited.listener.pid,
        startedAt: waited.listener.startedAt,
        inodes: [...waited.listener.inodes],
      };
      this.#debugLeases.set(view.sessionId, lease);
      return { port, command, logPath: serveDebugLogRel(port) };
    });
  }

  /**
   * デバッグ用 serve の状態。待受が無い lease はここで掃除し、次回からは lease 無し (追跡外) として見せる。
   * 応答はこの時点の走査結果で作るため、掃除の直前の呼び出しだけは「ポートはあるが待受が無い」を返す。
   */
  async debugStatus(sessionId: string): Promise<DebugServeStatus> {
    this.#view(sessionId);
    return this.#debugLock.run(async () => {
      const live = await this.#liveDebugPorts();
      const status = this.#composeDebug(sessionId, live);
      pruneDebugLeases(this.#debugLeases, live);
      return status;
    });
  }

  /**
   * 会話からの停止。lease の持ち主だけが止められる (`port` を指定しても他会話の lease なら 403)。
   * 削除の直後でも使えるよう、会話ストアは引かない (lease の sessionId だけで判定する)。
   */
  async debugStop(sessionId: string, input: { port?: number } = {}): Promise<DebugServeStopResult> {
    return this.#debugLock.run(async () => {
      const lease =
        input.port === undefined ? (this.#debugLeases.get(sessionId) ?? null) : (this.#leaseAtPort(input.port) ?? null);
      if (lease && lease.sessionId !== sessionId) {
        const title = this.#sessions.titleOfId(lease.sessionId);
        throw httpError(403, `このデバッグサーバーは会話「${title ?? ""}」が起動しました`);
      }
      const port = lease?.port ?? input.port;
      if (port === undefined) return { port: null, released: false, alreadyStopped: true };
      const result = await this.#stopDebugPort(port, lease);
      if (lease) this.#debugLeases.delete(lease.sessionId);
      return result;
    });
  }

  /**
   * ポート指定の強制停止 (所有者を問わない)。設定 → ランタイム からの回収が使う。
   * lease が残っていれば照合を取り、無ければ「レンジ内の待受 + 指定ポート」を条件に止める。
   */
  async debugStopPort(port: number): Promise<DebugServeStopResult> {
    return this.#debugLock.run(async () => {
      const lease = this.#leaseAtPort(port);
      const result = await this.#stopDebugPort(port, lease);
      if (lease) this.#debugLeases.delete(lease.sessionId);
      return result;
    });
  }

  /**
   * 会話 / スペースの削除に伴う回収。削除の成否を変えないため、失敗は warn にだけ残す
   * (残った待受は 設定 → ランタイム から回収できる)。サンドボックス未設定でも削除を巻き込まない。
   */
  async discardDebug(sessionId: string): Promise<void> {
    if (!this.#sandbox || !this.#debugLeases.has(sessionId)) return;
    try {
      await this.debugStop(sessionId);
    } catch (error) {
      console.warn(`[u7agent] 会話のデバッグ用 serve を停止できませんでした (${sessionId}): ${messageFor(error)}`);
    }
  }

  #view(sessionId: string): { sessionId: string; cwd: string; title: string } {
    const cwd = this.#sessions.workdirOfId(sessionId);
    if (cwd === undefined) throw httpError(404, "Session not found");
    return { sessionId, cwd, title: this.#sessions.titleOfId(sessionId) ?? "" };
  }

  /**
   * 置き換えの再照合に使う不透明な値。起動世代と「いま待受しているソケット」の同一性 (listen inode) を
   * 合わせて持つため、記録を残したまま生の bash で入れ替わった場合も確認が通らない。
   * 到達不可 (置き換える対象が無い) は null。
   */
  #confirmationToken(observation: ServeObservation): string | null {
    if (!observation.reachable) return null;
    const identity = observation.record && this.#matches(observation) ? observation.record.generation : "unknown";
    return createHash("sha256")
      .update(`${identity}:${observation.listenInodes.join(",")}`)
      .digest("hex")
      .slice(0, 8);
  }

  /** 置き換えの再照合。確認した値と実行時の値が違えば、UI に確認をやり直させる */
  #assertGeneration(observation: ServeObservation, expected: string | null): void {
    if (this.#confirmationToken(observation) === expected) return;
    throw httpError(409, "サービスの状態が変わりました。最新の状態で確認し直してください");
  }

  /**
   * 稼働判定は常にプローブ。記録は表示と操作権限のためだけに使い、到達可の根拠にはしない
   * (コンテナ再作成後に記録が残っていても「稼働中」と嘘をつかないため)。
   *
   * `scanPids` は待受 PID の特定 (service 本体での `/proc/<pid>/fd` 走査) を伴う。状態表示では不要なので
   * 既定は false で、停止対象の決定と起動の照合をするときだけ true にする。
   */
  async #observe(options: { fresh?: boolean; scanPids?: boolean } = {}): Promise<ServeObservation> {
    // サンドボックス未設定は「状態を取得できない」なので、プローブより先に 503 で止める
    // (プローブが false のときに 200 の停止状態を返さない)
    this.#requireSandbox();
    const cached = this.#cached;
    if (!options.scanPids && !options.fresh && cached && this.#now() - cached.at < this.#cacheMs) return cached;
    const reachable = await this.#probe();
    // 到達不可なら記録も待受 PID も表示に使わない (サンドボックスの呼び出しを増やさない)
    const observation: ServeObservation = reachable
      ? { reachable: true, ...(await this.#readObservation(options.scanPids === true)) }
      : { reachable: false, record: null, listenInodes: [], listener: null, at: this.#now() };
    this.#cached = observation;
    return observation;
  }

  async #readObservation(scanPids: boolean): Promise<Omit<ServeObservation, "reachable">> {
    const at = this.#now();
    // 記録の読み取りは Landlock の下の bash 実行、待受ソケットと PID の観測は制限の外の service 本体へ依頼する
    const [output, scan] = await Promise.all([
      this.#run(recordScript(), SERVE_WRITE_SCOPE),
      this.#scanListeners(this.#listenPort, scanPids),
    ]);
    return parseObservation(output, scan, at);
  }

  /** 待受ソケットと所有 PID の観測。bash 実行は他ドメインの fd を読めないので service 本体へ任せる */
  async #scanListeners(port: number, scanPids: boolean): Promise<SandboxListenerScan> {
    const sandbox = this.#requireSandbox();
    try {
      return await sandbox.scanListeners(port, { scan: scanPids });
    } catch (error) {
      throw sandboxFailure(error);
    }
  }

  /**
   * 記録と「いま待受しているプロセス」の照合。記録があるだけでは所有者とみなさない。
   * 根拠は待受ソケットの inode (fd 走査を伴う PID の特定を待たずに判定でき、状態表示と操作で同じ結果になる)。
   * inode を持たない記録 (この項目より前の版が書いたもの) は一致とみなさない。
   */
  #matches(observation: ServeObservation): boolean {
    const { record, listenInodes } = observation;
    if (!record || record.inodes.length === 0) return false;
    return sameInodes(record.inodes, listenInodes);
  }

  #ownerOf(view: { sessionId: string; title: string }, observation: ServeObservation): ServeOwner {
    if (!observation.reachable) return { kind: "none" };
    const record = observation.record;
    if (!record || !this.#matches(observation)) return { kind: "unknown" };
    if (record.sessionId === view.sessionId) return { kind: "mine", title: view.title };
    // 会話ストアの一覧 (descriptor) に無い会話は所有者として示さない (削除済みの記録を「他会話」と呼ばない)
    const title = this.#sessions.titleOfId(record.sessionId);
    return title === undefined ? { kind: "unknown" } : { kind: "other", title };
  }

  #compose(view: { sessionId: string; cwd: string; title: string }, observation: ServeObservation): ServeStatus {
    const stored = this.#db.getServeCommand(view.cwd);
    // 記録の世代は「今動いているプロセスが起動時に解決した値」なので、記録と待受が一致するときだけ返す
    const record = observation.record;
    return {
      reachable: observation.reachable,
      owner: this.#ownerOf(view, observation),
      generation: this.#confirmationToken(observation),
      command: stored ? { cwd: stored.cwd, command: stored.command } : null,
      secretGeneration: record && this.#matches(observation) ? record.secretGeneration : null,
    };
  }

  #composeRuntime(observation: ServeObservation): RuntimeServeStatus {
    const record = observation.reachable && this.#matches(observation) ? observation.record : null;
    const title = record ? this.#sessions.titleOfId(record.sessionId) : undefined;
    // 所属が引けないときは `?space=` を付けさせない (保存値で解決する現行どおりに戻す)
    const spaceId = record && title !== undefined ? this.#sessions.spaceOfId(record.sessionId) : undefined;
    return {
      reachable: observation.reachable,
      owner:
        record && title !== undefined
          ? { sessionId: record.sessionId, title, ...(spaceId === undefined ? {} : { spaceId }) }
          : null,
      generation: this.#confirmationToken(observation),
      command: record ? { cwd: record.cwd, command: record.command } : null,
    };
  }

  async #launch(
    view: { cwd: string },
    command: string,
    env: Record<string, string>,
    target: { log: string; port?: number },
  ): Promise<number> {
    // 起動対象の作業ディレクトリと作業領域だけを渡す (要求 cwd (= root) を混ぜない)
    const output = await this.#run(
      launchScript({
        workdir: view.cwd,
        command,
        log: target.log,
        ...(target.port === undefined ? {} : { port: target.port }),
      }),
      [{ path: view.cwd }, ...SERVE_WRITE_SCOPE_CREATE],
      env,
    );
    const line = output.split("\n").find((candidate) => candidate.startsWith("pid\t"));
    const pid = Number(line?.split("\t")[1]);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw httpError(502, "サンドボックスが serve の起動 PID を返しませんでした");
    }
    return pid;
  }

  async #writeRecord(record: ServeRecord): Promise<void> {
    await this.#run(writeRecordScript(record), SERVE_WRITE_SCOPE_CREATE);
  }

  async #clearRecord(): Promise<void> {
    await this.#run(clearRecordScript(), SERVE_WRITE_SCOPE);
  }

  /** 停止の実行。待受 PID を特定できないときは止めず、エージェントへ依頼する導線を案内する */
  async #stopListener(observation: ServeObservation): Promise<void> {
    const listener = observation.listener;
    if (!listener) {
      throw httpError(
        409,
        `${this.#listenPort} 番ポートの待受プロセスを特定できませんでした。エージェントに停止を依頼してください`,
      );
    }
    await this.#run(killScript(listener.pid), SERVE_WRITE_SCOPE);
    if (await this.#waitForRelease()) return;
    throw httpError(502, "serve の停止を確認できませんでした (ポートが解放されていません)");
  }

  async #waitForOwnListener(
    launchedPid: number,
  ): Promise<{ ok: true; listener: ServeListener } | { ok: false; reachable: boolean }> {
    const deadline = this.#now() + this.#startTimeoutMs;
    let reachable = false;
    for (;;) {
      if (await this.#probe()) {
        reachable = true;
        const observation = await this.#observe({ fresh: true, scanPids: true });
        if (observation.listener && isFromLaunch(observation.listener, launchedPid)) {
          return { ok: true, listener: observation.listener };
        }
        // 別のプロセスが使用中。次の確認まで長めに間を置く (fd 走査を連打しない)
        if (this.#now() >= deadline) return { ok: false, reachable };
        await this.#sleep(SERVE_OWN_LISTENER_INTERVAL_MS);
        continue;
      }
      if (this.#now() >= deadline) return { ok: false, reachable };
      await this.#sleep(SERVE_POLL_INTERVAL_MS);
    }
  }

  async #waitForRelease(): Promise<boolean> {
    const deadline = this.#now() + this.#stopTimeoutMs;
    for (;;) {
      if (!(await this.#probe())) return true;
      if (this.#now() >= deadline) return false;
      await this.#sleep(SERVE_POLL_INTERVAL_MS);
    }
  }

  /** lease を探す (ポートキーではないため、lease の数だけの線形探索で足りる) */
  #leaseAtPort(port: number): DebugServeLease | null {
    for (const lease of this.#debugLeases.values()) {
      if (lease.port === port) return lease;
    }
    return null;
  }

  #composeDebug(sessionId: string, livePorts: readonly number[]): DebugServeStatus {
    const lease = this.#debugLeases.get(sessionId);
    const listening = new Set(livePorts);
    return {
      lease: lease
        ? {
            port: lease.port,
            command: lease.command,
            logPath: serveDebugLogRel(lease.port),
            listening: listening.has(lease.port),
          }
        : null,
      untrackedPorts: livePorts.filter((port) => this.#leaseAtPort(port) === null),
    };
  }

  /** レンジ内で待受しているポート (fd 走査は伴わないので、取得のたびに呼んでも軽い) */
  async #liveDebugPorts(): Promise<number[]> {
    const sandbox = this.#requireSandbox();
    try {
      const scan = await sandbox.scanListenerRange(DEBUG_SERVE_PORT_FROM, DEBUG_SERVE_PORT_TO);
      return scan.ports.map((entry) => entry.port);
    } catch (error) {
      throw sandboxFailure(error);
    }
  }

  /** レンジ内の「lease が無く、待受も無い」最小ポート。満杯は起動せず、回収先を案内する 409 にする */
  async #allocateDebugPort(): Promise<number> {
    const live = await this.#liveDebugPorts();
    pruneDebugLeases(this.#debugLeases, live);
    const used = new Set(live);
    for (const lease of this.#debugLeases.values()) used.add(lease.port);
    for (let port = DEBUG_SERVE_PORT_FROM; port <= DEBUG_SERVE_PORT_TO; port += 1) {
      if (!used.has(port)) return port;
    }
    throw httpError(
      409,
      `デバッグ枠 (${DEBUG_SERVE_PORT_FROM}–${DEBUG_SERVE_PORT_TO}) が満杯です。設定 → ランタイムの一覧から不要なデバッグ用 serve を停止してから再試行してください`,
    );
  }

  /**
   * 待受の確認。TCP connect ではなく走査を使う (コンテナ構成では BFF から 127.0.0.1 へ届かない)。
   * 軽い走査で inode の有無をポーリングし、待受が現れたら fd 走査を 1 回だけ呼んで起動由来を照合する。
   */
  async #waitForDebugListener(
    port: number,
    launchedPid: number,
  ): Promise<
    { ok: true; listener: ServeListener } | { ok: false; reason: DebugStartFailure; listener: ServeListener | null }
  > {
    const deadline = this.#now() + this.#startTimeoutMs;
    for (;;) {
      const scan = await this.#scanListeners(port, false);
      if (scan.inodes.length > 0) {
        const detailed = await this.#scanListeners(port, true);
        const mine = detailed.listener && isFromLaunch(detailed.listener, launchedPid) ? detailed.listener : null;
        // ループバック以外の bind は待っても直らない。照合できた起動分だけを後始末へ渡す
        if (scan.addressScopes.some((scope) => scope !== "loopback")) {
          return { ok: false, reason: "non-loopback", listener: mine };
        }
        if (mine) return { ok: true, listener: mine };
        // 別のプロセスが使用中。次の確認まで長めに間を置く (fd 走査を連打しない)
        if (this.#now() >= deadline) return { ok: false, reason: "other", listener: detailed.listener ?? null };
        await this.#sleep(SERVE_OWN_LISTENER_INTERVAL_MS);
        continue;
      }
      if (this.#now() >= deadline) return { ok: false, reason: "timeout", listener: null };
      await this.#sleep(SERVE_POLL_INTERVAL_MS);
    }
  }

  /** 失敗した起動の後始末。照合できた待受だけを停止し、停止できなかった理由を返す (lease は作らない) */
  async #abandonDebugStart(port: number, launchedPid: number, listener: ServeListener | null): Promise<string | null> {
    if (!listener || !isFromLaunch(listener, launchedPid)) {
      return listener ? "起動に由来しないプロセスが待ち受けているため停止できませんでした" : null;
    }
    try {
      await this.#run(killScript(listener.pid), SERVE_WRITE_SCOPE);
      if (await this.#waitForDebugRelease(port)) return null;
      return "停止を確認できませんでした";
    } catch (error) {
      return `停止に失敗しました: ${messageFor(error)}`;
    }
  }

  /**
   * デバッグ用 serve の停止。对象は「いまそのポートで待受している PID」で、lease があるときは
   * 起動時との照合が取れたときだけ kill する (dev は /proc を共有するため、無関係なプロセスを殺さない)。
   */
  async #stopDebugPort(port: number, lease: DebugServeLease | null): Promise<DebugServeStopResult> {
    if (!isDebugServePort(port)) {
      throw httpError(400, `デバッグ用 serve のポートは ${DEBUG_SERVE_PORT_FROM}–${DEBUG_SERVE_PORT_TO} です`);
    }
    const scan = await this.#scanListeners(port, true);
    if (scan.inodes.length === 0) return { port, released: false, alreadyStopped: true };
    const listener = scan.listener;
    if (!listener) throw httpError(409, `${port} 番ポートの待受プロセスを特定できませんでした`);
    if (lease && !matchesDebugLease(listener, lease)) {
      throw httpError(
        409,
        `デバッグ用 serve の待受プロセスが起動時と一致しないため停止しませんでした (${port} 番ポート)`,
      );
    }
    await this.#run(killScript(listener.pid), SERVE_WRITE_SCOPE);
    if (!(await this.#waitForDebugRelease(port))) {
      throw httpError(502, `デバッグ用 serve の停止を確認できませんでした (${port} 番ポートが解放されていません)`);
    }
    return { port, released: true, alreadyStopped: false };
  }

  /** 同じ会話の再起動。前のプロセスを停止して解放を確認してからでないと次を起動しない */
  async #releaseDebugLease(sessionId: string): Promise<void> {
    const lease = this.#debugLeases.get(sessionId);
    if (!lease) return;
    await this.#stopDebugPort(lease.port, lease);
    this.#debugLeases.delete(sessionId);
  }

  async #waitForDebugRelease(port: number): Promise<boolean> {
    const deadline = this.#now() + this.#stopTimeoutMs;
    for (;;) {
      const scan = await this.#scanListeners(port, false);
      if (scan.inodes.length === 0) return true;
      if (this.#now() >= deadline) return false;
      await this.#sleep(SERVE_POLL_INTERVAL_MS);
    }
  }

  /** サンドボックス未設定は 503。プローブより先に呼び、到達不可へ丸めない */
  #requireSandbox(): SandboxServeClient {
    if (!this.#sandbox) throw httpError(503, SANDBOX_NOT_CONFIGURED_MESSAGE);
    return this.#sandbox;
  }

  /**
   * サンドボックスの bash 実行。作業領域の読み書きも起動・停止もこの 1 経路に集める。
   * `scope` はこの実行が書き込める root 相対の範囲 (必須)。要求 cwd (`cwd: ""` = root) からは導出しない。
   * `env` はこの実行の子プロセスへ足す環境変数で、起動 (launch) だけが渡す。値はコマンド文字列へ
   * 埋めず、リクエストの別フィールドとして送る (base64 化もしない)。
   */
  async #run(script: string, scope: readonly SandboxWriteScopeEntry[], env?: Record<string, string>): Promise<string> {
    const sandbox = this.#requireSandbox();
    const result = await sandbox
      .execute("bash", {
        params: { command: script, timeout: SANDBOX_SCRIPT_TIMEOUT_SECONDS },
        cwd: "",
        writeScope: [...scope],
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      })
      .catch((error: unknown) => {
        throw sandboxFailure(error);
      });
    const text = textOfContent(result.content);
    if (!text.includes(SCRIPT_OK)) {
      throw httpError(502, `サンドボックスの serve 操作に失敗しました: ${text.trim() || "(no output)"}`);
    }
    return text;
  }
}

/** サンドボックス呼び出しの失敗は「状態が取れない」なので、停止中へ丸めず 502 にする (状態コード付きはそのまま) */
function sandboxFailure(error: unknown): Error {
  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === "number") return error as Error;
  return httpError(502, `サンドボックスの serve 操作に失敗しました: ${messageFor(error)}`);
}
