/**
 * serve (UI 上の呼称は「サービス」) の状態と起動・停止。公開枠は全会話で共有の 1 本で、
 * 誰が動かしているかはサンドボックスの作業領域 (`<appdir>/serve/state.json`) の記録と
 * 「いま待受しているプロセス」の照合で決める。設計は docs/sandbox.md の serve の節を正とする。
 */
import { randomBytes, createHash } from "node:crypto";
import { createConnection } from "node:net";
import { SERVE_DIR_REL, SERVE_LOG_REL, SERVE_STATE_REL } from "./app-paths";
import type { ServeCommandRow } from "./app-db";
import { SANDBOX_NOT_CONFIGURED_MESSAGE, httpError } from "./http";
import { MutationLock } from "./model-settings";
// serve 契約の待受ポート。プローブも待受 PID の特定も、サービス オリジンの転送先もこの値だけを見る
import { SERVE_LISTEN_PORT } from "./preview-port";
import type { SandboxExecClient } from "./sandbox/client";
import type { SandboxWriteScopeEntry } from "./sandbox/protocol";
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

/** 会話 id から作業ディレクトリと会話名を引く (SessionStore が実装する) */
export interface ServeSessionLookup {
  /** root 相対。未知の会話は undefined */
  workdirOfId(id: string): string | undefined;
  titleOfId(id: string): string | undefined;
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
  sandbox: SandboxExecClient | null;
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
 * 記録と待受ソケットを 1 回の実行で読む。
 *
 * 重い fd 走査（待受 PID の特定）は `scanPids` のときだけ行う。状態表示は `/proc/net/tcp` の listen inode
 * だけで所有者を分類でき（記録の inode と照合する）、PID は停止対象の決定と「起動したプロセスが待受を
 * 始めたか」の判定にしか使わない。走査は node の 1 プロセスで行い、fd ごとに外部コマンドを起動しない
 * （高負荷時に 15 秒以上かかり、状態取得のタイムアウトと表示のスタックを起こしていた）。
 */
function observeScript(port: number, options: { scanPids: boolean }): string {
  return `node --input-type=commonjs -e '${[
    'const fs = require("node:fs");',
    `const SUFFIX = ":${port.toString(16).toUpperCase().padStart(4, "0")}";`,
    `const SCAN = ${options.scanPids ? "true" : "false"};`,
    "const inodes = [];",
    'for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {',
    '  let text = "";',
    '  try { text = fs.readFileSync(file, "utf8"); } catch (error) { continue; }',
    "  for (const line of text.split(String.fromCharCode(10)).slice(1)) {",
    "    const parts = line.trim().split(/ +/);",
    '    if (parts.length < 10 || parts[3] !== "0A") continue;',
    '    if (!(parts[1] || "").endsWith(SUFFIX)) continue;',
    "    const inode = Number(parts[9]);",
    "    if (Number.isInteger(inode) && inodes.indexOf(inode) === -1) inodes.push(inode);",
    "  }",
    "}",
    "inodes.sort((a, b) => a - b);",
    'const lines = ["inodes\\t" + inodes.join(" ")];',
    "if (SCAN) {",
    '  const wanted = inodes.map((inode) => "socket:[" + inode + "]");',
    "  let pid = 0;",
    '  for (const entry of fs.readdirSync("/proc")) {',
    "    if (!/^[0-9]+$/.test(entry)) continue;",
    "    let fds = [];",
    '    try { fds = fs.readdirSync("/proc/" + entry + "/fd"); } catch (error) { continue; }',
    "    for (const fd of fds) {",
    '      let link = "";',
    '      try { link = fs.readlinkSync("/proc/" + entry + "/fd/" + fd); } catch (error) { continue; }',
    "      if (wanted.indexOf(link) === -1) continue;",
    "      pid = Number(entry);",
    "      break;",
    "    }",
    "    if (pid) break;",
    "  }",
    "  if (pid) {",
    "    let startedAt = 0;",
    "    try {",
    '      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");',
    '      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);',
    '      const btime = Number((/btime ([0-9]+)/.exec(fs.readFileSync("/proc/stat", "utf8")) || [])[1]);',
    "      if (Number.isFinite(ticks) && Number.isFinite(btime)) startedAt = btime * 1000 + Math.round(ticks * 10);",
    "    } catch (error) { startedAt = 0; }",
    '    lines.push("listener\\t" + pid + "\\t" + startedAt);',
    "    const chain = [];",
    "    let cur = pid;",
    "    while (cur && cur !== 1 && chain.length < 32) {",
    "      chain.push(cur);",
    "      let parent = 0;",
    "      try {",
    '        const stat = fs.readFileSync("/proc/" + cur + "/stat", "utf8");',
    '        parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);',
    "      } catch (error) { parent = 0; }",
    "      cur = Number.isInteger(parent) ? parent : 0;",
    "    }",
    '    lines.push("ancestors\\t" + chain.join(" "));',
    "  }",
    "}",
    `try { lines.push("record\\t" + fs.readFileSync("${SERVE_STATE_REL}", "utf8").trim()); } catch (error) {}`,
    "console.log(lines.join(String.fromCharCode(10)));",
    "' || { echo 'serve: scan failed' >&2; exit 1; }",
    `echo ${SCRIPT_OK}`,
  ].join("\n")}`;
}

/**
 * バックグラウンド起動。ログは固定パスへ出し、起動した PID を返す。
 * 作業ディレクトリも base64 で渡す (shell へ値を直接埋め込まない。パス中の `$` やバッククォートを評価させない)。
 */
function launchScript(input: { workdir: string; command: string }): string {
  return `set -u
root=$PWD
dir="$root/.u7agent/serve"
mkdir -p "$dir" || { echo "serve: mkdir failed" >&2; exit 1; }
log="$root/${SERVE_LOG_REL}"
: > "$log" || { echo "serve: cannot open the log" >&2; exit 1; }
workdir=$(printf '%s' '${encode(input.workdir)}' | base64 -d) || exit 1
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
 * スクリプトの出力を観測値へ。印の確認は呼び出し側 (#run) が行う。
 * 出力は `inodes` → `listener` → `ancestors` の順だが、**行の順序に依存しない**ように全行を読んでから
 * listener へ祖先を反映する (listener 行の時点で祖先はまだ読めていない)。
 */
function parseObservation(output: string, at: number): Omit<ServeObservation, "reachable"> {
  let record: ServeRecord | null = null;
  let listener: ServeListener | null = null;
  let listenInodes: number[] = [];
  let ancestors: number[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("record\t")) {
      record = parseRecord(line.slice("record\t".length));
    } else if (line.startsWith("inodes\t")) {
      listenInodes = numberList(line.slice("inodes\t".length));
    } else if (line.startsWith("ancestors\t")) {
      ancestors = numberList(line.slice("ancestors\t".length));
    } else if (line.startsWith("listener\t")) {
      const [, pid, startedAt] = line.split("\t");
      const parsedPid = Number(pid);
      const parsedStartedAt = Number(startedAt);
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        listener = {
          pid: parsedPid,
          // 起動時刻を引けなかったときは 0 (不明) とし、照合は pid だけで行う
          startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : 0,
          inodes: [],
          ancestors: [],
        };
      }
    }
  }
  // 祖先と inode は listener 行より後ろに現れるため、全行を読んだ後に反映する
  if (listener) {
    listener = { ...listener, inodes: [...listenInodes], ancestors };
  }
  return { record, listenInodes, listener, at };
}

/** 空白区切りの数値列。範囲外は落とす */
function numberList(value: string): number[] {
  return value
    .trim()
    .split(" ")
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
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
  #sandbox: SandboxExecClient | null;
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

  async runtimeStatus(): Promise<RuntimeServeStatus> {
    return this.#composeRuntime(await this.#observe());
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
      const pid = await this.#launch(view, command, { ...env.variables, ...env.secrets });
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
   * `scanPids` は待受 PID の特定 (fd 走査) を伴う。状態表示では不要なので既定は false で、
   * 停止対象の決定と起動の照合をするときだけ true にする。
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
    return parseObservation(await this.#run(observeScript(this.#listenPort, { scanPids }), SERVE_WRITE_SCOPE), at);
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
    return {
      reachable: observation.reachable,
      owner: record && title !== undefined ? { sessionId: record.sessionId, title } : null,
      generation: this.#confirmationToken(observation),
      command: record ? { cwd: record.cwd, command: record.command } : null,
    };
  }

  async #launch(view: { cwd: string }, command: string, env: Record<string, string>): Promise<number> {
    // 起動対象の作業ディレクトリと作業領域だけを渡す (要求 cwd (= root) を混ぜない)
    const output = await this.#run(
      launchScript({ workdir: view.cwd, command }),
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

  /** サンドボックス未設定は 503。プローブより先に呼び、到達不可へ丸めない */
  #requireSandbox(): SandboxExecClient {
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
        // サンドボックス呼び出しの失敗は「状態が取れない」なので、停止中へ丸めず 502 にする
        const status = (error as { statusCode?: number }).statusCode;
        if (typeof status === "number") throw error;
        throw httpError(502, `サンドボックスの serve 操作に失敗しました: ${messageFor(error)}`);
      });
    const text = textOfContent(result.content);
    if (!text.includes(SCRIPT_OK)) {
      throw httpError(502, `サンドボックスの serve 操作に失敗しました: ${text.trim() || "(no output)"}`);
    }
    return text;
  }
}
