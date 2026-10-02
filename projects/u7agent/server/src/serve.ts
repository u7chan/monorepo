/**
 * serve (UI 上の呼称は「サービス」) の状態と起動・停止。公開枠は全会話で共有の 1 本で、
 * 誰が動かしているかはサンドボックスの作業領域 (`<appdir>/serve/state.json`) の記録と
 * 「いま待受しているプロセス」の照合で決める。設計は docs/sandbox.md の serve の節を正とする。
 */
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { SERVE_LOG_REL, SERVE_STATE_REL } from "./app-paths";
import type { ServeCommandRow } from "./app-db";
import { httpError } from "./http";
import { MutationLock } from "./model-settings";
import type { SandboxExecClient } from "./sandbox/client";

/** serve 契約の待受ポート。プローブも待受 PID の特定もこの値だけを見る */
export const SERVE_LISTEN_PORT = 8080;
/** 起動の成功境界。バックグラウンド起動の shell が終わってからこの期限までに到達可になること */
export const SERVE_START_TIMEOUT_MS = 10_000;
/** 停止後にポートの解放を確認する期限 */
export const SERVE_STOP_TIMEOUT_MS = 5_000;
/** 1 回の TCP connect の期限。4 秒のポーリングに乗るため短くする */
export const SERVE_PROBE_TIMEOUT_MS = 1_000;
/** 判定の使い回し。複数タブが同じ結果を使う。起動・停止の直後は必ず捨てる */
export const SERVE_STATUS_CACHE_MS = 2_000;
/** 期限つき待ちの再確認間隔 */
const SERVE_POLL_INTERVAL_MS = 250;
/** 記録の pid と /proc の起動時刻の許容差。秒未満の丸めだけを吸収する */
const SERVE_RECORD_TOLERANCE_MS = 2_000;
/** サンドボックスの bash 実行に渡す期限 (秒)。待ちは BFF 側で行うため、スクリプト自体は短命 */
const SANDBOX_SCRIPT_TIMEOUT_SECONDS = 20;
/** スクリプトが最後に出す印。欠けていればサンドボックス側の失敗として扱う */
const SCRIPT_OK = "serve:ok";

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
}

/** 全体で 1 つの live な稼働記録。サンドボックスの作業領域へ同じ内容を書く */
export interface ServeRecord {
  /** 所有者セッション id */
  sessionId: string;
  /** 起動時の作業ディレクトリ (root 相対) */
  cwd: string;
  command: string;
  /** 起動時の PID (到達できたら「いま待受しているプロセス」の PID で上書きする) */
  pid: number;
  startedAt: number;
  /** 起動のたびに変わる値 */
  generation: string;
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
 * プローブ先のホスト。BFF とサンドボックスは別コンテナ / 別プロセスなので、`PI_SANDBOX_URL` の
 * ホストへ serve listen ポートで繋ぐ (ツール API のポートとは別)。解決できなければ undefined。
 */
export function sandboxHostFromUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  try {
    return new URL(text).hostname || undefined;
  } catch {
    return undefined;
  }
}

interface ServeObservation {
  reachable: boolean;
  record: ServeRecord | null;
  /** いま listen しているプロセス。特定できなければ null */
  listener: { pid: number; startedAt: number } | null;
  at: number;
}

export interface ServeServiceOptions {
  appDb: ServeCommandStore;
  sessions: ServeSessionLookup;
  /** 未設定なら serve の API / ツールは 503 */
  sandbox: SandboxExecClient | null;
  /** プローブ先のホスト。未指定は 127.0.0.1 (同一ホストのサンドボックス) */
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
 * 記録と待受プロセスを 1 回の bash 実行で読む。待受 PID は `/proc/net/tcp` の listen エントリの inode と
 * `/proc/<pid>/fd` の照合で引く (ss / fuser / lsof はイメージに入っていない)。
 * 起動時刻は clock tick を秒へ直すため `getconf CLK_TCK` を使い、`/proc/stat` の btime と足して epoch ms にする。
 */
function observeScript(port: number): string {
  return `set -u
root=$PWD
state="$root/${SERVE_STATE_REL}"
hex=$(printf '%04X' ${port})
inodes=$(awk -v p=":$hex" '$4 == "0A" && substr($2, length($2) - 4) == p { print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)
listener=
if [ -n "$inodes" ]; then
  for fd in /proc/[0-9]*/fd/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    case "$link" in
      socket:\\[*) ino=\${link#socket:[}; ino=\${ino%]} ;;
      *) continue ;;
    esac
    case " $inodes " in
      *" $ino "*) ;;
      *) continue ;;
    esac
    listener=\${fd#/proc/}
    listener=\${listener%%/*}
    break
  done
fi
if [ -n "$listener" ]; then
  ticks=$(sed 's/^.*) //' "/proc/$listener/stat" 2>/dev/null | awk '{ print $20 }')
  hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
  btime=$(awk '/^btime /{ print $2 }' /proc/stat 2>/dev/null)
  started=
  if [ -n "$ticks" ] && [ -n "$btime" ]; then
    started=$(( btime * 1000 + ticks * 1000 / hz ))
  fi
  printf 'listener\\t%s\\t%s\\n' "$listener" "\${started:-}"
fi
if [ -f "$state" ]; then
  printf 'record\\t'
  cat "$state"
  printf '\\n'
fi
echo ${SCRIPT_OK}
`;
}

/** バックグラウンド起動。ログは固定パスへ出し、起動した PID を返す */
function launchScript(input: { workdir: string; command: string }): string {
  return `set -u
root=$PWD
dir="$root/.u7agent/serve"
mkdir -p "$dir" || { echo "serve: mkdir failed" >&2; exit 1; }
log="$root/${SERVE_LOG_REL}"
: > "$log" || { echo "serve: cannot open the log" >&2; exit 1; }
cd "$root/${input.workdir}" || { echo "serve: cannot enter the working directory" >&2; exit 1; }
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
  const { sessionId, cwd, command, pid, startedAt, generation } = parsed as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof cwd !== "string") return null;
  if (typeof command !== "string" || command === "") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (typeof generation !== "string" || generation === "") return null;
  return { sessionId, cwd, command, pid, startedAt, generation };
}

/** スクリプトの出力を観測値へ。印の確認は呼び出し側 (#run) が行う */
function parseObservation(output: string, at: number): Omit<ServeObservation, "reachable"> {
  let record: ServeRecord | null = null;
  let listener: { pid: number; startedAt: number } | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("record\t")) {
      record = parseRecord(line.slice("record\t".length));
    } else if (line.startsWith("listener\t")) {
      const [, pid, startedAt] = line.split("\t");
      const parsedPid = Number(pid);
      const parsedStartedAt = Number(startedAt);
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        listener = {
          pid: parsedPid,
          // 起動時刻を引けなかったときは 0 (不明) とし、照合は pid だけで行う
          startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : 0,
        };
      }
    }
  }
  return { record, listener, at };
}

export class ServeService {
  #db: ServeCommandStore;
  #sessions: ServeSessionLookup;
  #sandbox: SandboxExecClient | null;
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
    this.#listenPort = options.listenPort ?? SERVE_LISTEN_PORT;
    this.#probe =
      options.probe ?? tcpProbe(options.sandboxHost ?? "127.0.0.1", this.#listenPort, SERVE_PROBE_TIMEOUT_MS);
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
   * 起動。到達可なら所有者の有無に関わらず置き換える (所有者の確認は UI が取る)。
   * 成功境界は「バックグラウンド起動の shell が終わってから、期限つきでプローブが到達可になること」。
   */
  async start(sessionId: string, input: { command?: string; generation?: string | null } = {}): Promise<ServeStatus> {
    const view = this.#view(sessionId);
    const explicit = input.command?.trim();
    return this.#lock.run(async () => {
      this.#cached = null;
      const before = await this.#observe({ fresh: true });
      if (before.reachable) {
        this.#assertGeneration(before, input.generation ?? null);
        // 置き換えは所有者を問わない (UI が所有者名を出して確認してから呼ぶ)
        await this.#stopListener(before);
      }
      const command = explicit || this.#db.getServeCommand(view.cwd)?.command;
      if (!command) throw httpError(400, "この作業ディレクトリには serve の実績がありません");
      const generation = randomBytes(4).toString("hex");
      const pid = await this.#launch(view, command);
      // 失敗しても「起動を試みた事実」は残す。以前の成功コマンドは上書きしない
      let record: ServeRecord = {
        sessionId: view.sessionId,
        cwd: view.cwd,
        command,
        pid,
        startedAt: this.#now(),
        generation,
      };
      await this.#writeRecord(record);
      if (!(await this.#waitForReachable())) {
        this.#cached = null;
        throw httpError(
          502,
          `serve を起動しましたが、期限内に ${this.#listenPort} 番ポートへ到達できませんでした。${SERVE_LOG_REL} のログを確認してください`,
        );
      }
      // 到達できたら「いま待受しているプロセス」を正として記録し直す (所有者の照合を効かせる)
      const after = await this.#observe({ fresh: true });
      if (after.listener) {
        record = { ...record, pid: after.listener.pid, startedAt: after.listener.startedAt };
        await this.#writeRecord(record);
      }
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
      const before = await this.#observe({ fresh: true });
      if (!before.reachable) {
        // 到達不可なら止めるものが無い。記録だけ片付ける (停止済みとして扱う)
        if (before.record) await this.#clearRecord();
        this.#cached = null;
        return this.#compose(view, { reachable: false, record: null, listener: null, at: this.#now() });
      }
      this.#assertGeneration(before, input.generation ?? null);
      const owner = this.#ownerOf(view, before);
      if (owner.kind === "other") {
        throw httpError(403, `このサービスは会話「${owner.title ?? ""}」が公開しています`);
      }
      await this.#stopListener(before);
      await this.#clearRecord();
      this.#cached = null;
      return this.#compose(view, { reachable: false, record: null, listener: null, at: this.#now() });
    });
  }

  #view(sessionId: string): { sessionId: string; cwd: string; title: string } {
    const cwd = this.#sessions.workdirOfId(sessionId);
    if (cwd === undefined) throw httpError(404, "Session not found");
    return { sessionId, cwd, title: this.#sessions.titleOfId(sessionId) ?? "" };
  }

  /** 置き換えの再照合。確認した世代と実行時の世代が違えば、UI に確認をやり直させる */
  #assertGeneration(observation: ServeObservation, expected: string | null): void {
    const current = observation.record?.generation ?? null;
    if (current === expected) return;
    throw httpError(409, "サービスの状態が変わりました。最新の状態で確認し直してください");
  }

  /**
   * 稼働判定は常にプローブ。記録は表示と操作権限のためだけに使い、到達可の根拠にはしない
   * (コンテナ再作成後に記録が残っていても「稼働中」と嘘をつかないため)。
   */
  async #observe(options: { fresh?: boolean } = {}): Promise<ServeObservation> {
    const cached = this.#cached;
    if (!options.fresh && cached && this.#now() - cached.at < this.#cacheMs) return cached;
    const reachable = await this.#probe();
    // 到達不可なら記録も待受 PID も表示に使わない (サンドボックスの呼び出しを増やさない)
    const observation: ServeObservation = reachable
      ? { reachable: true, ...(await this.#readObservation()) }
      : { reachable: false, record: null, listener: null, at: this.#now() };
    this.#cached = observation;
    return observation;
  }

  async #readObservation(): Promise<Omit<ServeObservation, "reachable">> {
    const at = this.#now();
    return parseObservation(await this.#run(observeScript(this.#listenPort)), at);
  }

  /** 記録と待受プロセスの照合。記録があるだけでは所有者とみなさない */
  #matches(observation: ServeObservation): boolean {
    const { record, listener } = observation;
    if (!record || !listener) return false;
    if (record.pid !== listener.pid) return false;
    if (listener.startedAt === 0) return true;
    return Math.abs(record.startedAt - listener.startedAt) <= SERVE_RECORD_TOLERANCE_MS;
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
    return {
      reachable: observation.reachable,
      owner: this.#ownerOf(view, observation),
      generation: observation.record?.generation ?? null,
      command: stored ? { cwd: stored.cwd, command: stored.command } : null,
    };
  }

  async #launch(view: { cwd: string }, command: string): Promise<number> {
    const output = await this.#run(launchScript({ workdir: view.cwd, command }));
    const line = output.split("\n").find((candidate) => candidate.startsWith("pid\t"));
    const pid = Number(line?.split("\t")[1]);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw httpError(502, "サンドボックスが serve の起動 PID を返しませんでした");
    }
    return pid;
  }

  async #writeRecord(record: ServeRecord): Promise<void> {
    await this.#run(writeRecordScript(record));
  }

  async #clearRecord(): Promise<void> {
    await this.#run(clearRecordScript());
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
    await this.#run(killScript(listener.pid));
    if (await this.#waitForRelease()) return;
    throw httpError(502, "serve の停止を確認できませんでした (ポートが解放されていません)");
  }

  async #waitForReachable(): Promise<boolean> {
    const deadline = this.#now() + this.#startTimeoutMs;
    for (;;) {
      if (await this.#probe()) return true;
      if (this.#now() >= deadline) return false;
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

  /** サンドボックスの bash 実行。作業領域の読み書きも起動・停止もこの 1 経路に集める */
  async #run(script: string): Promise<string> {
    const sandbox = this.#sandbox;
    if (!sandbox) {
      throw httpError(503, "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)");
    }
    const result = await sandbox
      .execute("bash", {
        params: { command: script, timeout: SANDBOX_SCRIPT_TIMEOUT_SECONDS },
        cwd: "",
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
