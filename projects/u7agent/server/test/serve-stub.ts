/**
 * serve のテスト用スタブ。サンドボックスへ送る bash スクリプトを解釈し、作業領域の状態
 * (記録 / 待受 PID) をポートキーで仮想的に持つ。公開枠とデバッグ枠を同時に表現できる。
 * 実スクリプトの文言を変えたらここも追随させる。
 */
import type { ServeCommandRow } from "../src/app-db";
import { SERVE_LISTEN_PORT } from "../src/preview-port";
import type { SandboxServeClient } from "../src/sandbox/client";
import type { SandboxListenerAddressScope, SandboxWriteScopeEntry } from "../src/sandbox/protocol";
import type { ServeCommandStore, ServeProbe, ServeSessionLookup } from "../src/serve";

/** いま listen しているプロセス。ancestors は自身から親をたどった PID */
export interface ServeSandboxListener {
  pid: number;
  startedAt: number;
  inodes: number[];
  ancestors: number[];
}

export interface ServeSandboxState {
  /** 仮想の `<appdir>/serve/state.json` の中身。キーは公開枠の待受ポート (稼働記録は公開枠に 1 つ) */
  stateFiles: Map<number, string>;
  /** いま listen しているプロセス。キーは待受ポート (公開枠 / デバッグ枠の両方を 1 つの Map で表す) */
  listeners: Map<number, ServeSandboxListener>;
  /** 公開枠の待受ポート。稼働記録の読み書きが使うキー */
  publicPort: number;
  /** launch スクリプトが起動したと見なす PID。起動のたびに増やし、並列の起動を区別する */
  launchPid: number;
  /** launch で listen が始まるか。false で「起動したが到達しない」を再現する */
  launchListens: boolean;
  /**
   * launch と同時に listen を始める別のプロセス (遅れて listen した別の起動の再現)。
   * 設定されていると launch はこちらの listener を返す
   */
  listenerOnLaunch: ServeSandboxListener | null;
  /** launch で listen を始めるソケットの inode。空なら起動 PID と同じ値を inode にする */
  launchInodes: number[];
  /** listen しているが PID を特定できない状態の inode (fd 走査をしても listener 行を返さない) */
  orphanInodes: number[];
  /** launch したプロセスの起動時刻 (観測スクリプトが返す値) */
  launchStartedAt: number;
  /** launch した待受が返すアドレス種別。null は inode ごとに loopback */
  launchAddressScopes: SandboxListenerAddressScope[] | null;
  /** launch へ渡したポート (公開枠は null)。作業ディレクトリ / コマンド / ログと組で控える */
  launched: Array<{ workdir: string; command: string; log: string; port: number | null }>;
  /** launch へ渡した env (渡さなければ undefined)。起動時の環境変数注入の検証に使う */
  launchEnvs: (Record<string, string> | undefined)[];
  killed: number[];
  /** kill が効くか。false で「停止してもポートが空かない」状態を再現する */
  killWorks: boolean;
  /** 記録を書いた回数 (起動の成功では仮の記録と待受 PID の 2 回) */
  writes: number;
  /** fd 走査つきの観測回数 (状態表示では増えない) */
  scans: number;
  /** 待受観測を失敗させる残り回数 (期限切れの写像とロック解放の検証に使う) */
  scanFailures: number;
  /** サンドボックス側の失敗を再現する (印を返さない) */
  fail: boolean;
}

export interface ServeSandboxStub {
  sandbox: SandboxServeClient;
  state: ServeSandboxState;
  /** execute に渡された cwd (作業領域の読み書きは root で行う) */
  cwds: string[];
  /** execute に渡された writeScope (内部実行は要求 cwd から導出させない) */
  scopes: (readonly SandboxWriteScopeEntry[] | undefined)[];
}

/** スクリプトに埋め込まれた base64 を取り出す (launch は workdir → command の順に埋め込む) */
function embedded(script: string): string[] {
  return [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/g)].map((match) =>
    Buffer.from(match[1], "base64").toString("utf8"),
  );
}

export function createServeSandboxStub(options: { publicPort?: number } = {}): ServeSandboxStub {
  const state: ServeSandboxState = {
    stateFiles: new Map(),
    listeners: new Map(),
    publicPort: options.publicPort ?? SERVE_LISTEN_PORT,
    launchPid: 4242,
    launchListens: true,
    listenerOnLaunch: null,
    launchInodes: [],
    orphanInodes: [],
    launchStartedAt: 1_700_000_000_000,
    launchAddressScopes: null,
    launched: [],
    launchEnvs: [],
    killed: [],
    writes: 0,
    scans: 0,
    scanFailures: 0,
    fail: false,
    killWorks: true,
  };
  const cwds: string[] = [];
  const scopes: (readonly SandboxWriteScopeEntry[] | undefined)[] = [];
  const sandbox: SandboxServeClient = {
    execute: async (_tool, input) => {
      cwds.push(input.cwd ?? "");
      scopes.push(input.writeScope);
      if (state.fail) throw new Error("サンドボックスのツール実行が失敗しました (HTTP 500)");
      const { command } = (input.params ?? {}) as { command?: string };
      const script = command ?? "";
      if (script.includes("nohup bash -c")) {
        const [workdir, command] = embedded(script);
        const debugPort = /export U7AGENT_DEBUG_PORT=(\d+)/.exec(script)?.[1];
        const port = debugPort === undefined ? state.publicPort : Number(debugPort);
        const pid = state.launchPid;
        state.launchPid += 1;
        state.launchEnvs.push(input.env);
        state.launched.push({
          workdir: workdir ?? "",
          command: command ?? "",
          log: /log="\$root\/([^"]*)"/.exec(script)?.[1] ?? "",
          port: debugPort === undefined ? null : port,
        });
        if (state.listenerOnLaunch) {
          state.listeners.set(port, { ...state.listenerOnLaunch });
        } else if (state.launchListens) {
          state.listeners.set(port, {
            pid,
            startedAt: state.launchStartedAt,
            inodes: state.launchInodes.length > 0 ? [...state.launchInodes] : [pid],
            ancestors: [pid],
          });
        }
        return { content: [{ type: "text", text: `pid\t${pid}\nserve:ok\n` }] };
      }
      if (script.includes("rm -f")) {
        state.stateFiles.delete(state.publicPort);
        return { content: [{ type: "text", text: "serve:ok\n" }] };
      }
      if (script.includes("kill ")) {
        const pid = Number(/kill (\d+)/.exec(script)?.[1]);
        state.killed.push(pid);
        if (state.killWorks) {
          for (const [port, listener] of state.listeners) {
            if (listener.pid === pid) state.listeners.delete(port);
          }
        }
        return { content: [{ type: "text", text: "serve:ok\n" }] };
      }
      if (script.includes("state.json") && script.includes("base64 -d")) {
        state.stateFiles.set(state.publicPort, embedded(script)[0] ?? "");
        state.writes += 1;
        return { content: [{ type: "text", text: "serve:ok\n" }] };
      }
      // 稼働記録の読み取り (待受ソケットと PID は scanListeners が返す)
      if (script.includes("readFileSync") && script.includes("state.json")) {
        const raw = state.stateFiles.get(state.publicPort);
        const record = raw ? `record\t${raw}\n` : "";
        return { content: [{ type: "text", text: `${record}serve:ok\n` }] };
      }
      throw new Error(`unexpected serve script: ${script.slice(0, 64)}`);
    },
    // 待受ソケットの inode は常に返し、fd 走査つき (scan) のときだけ listener / ancestors を返す
    scanListeners: async (port, { scan }) => {
      if (state.scanFailures > 0) {
        state.scanFailures -= 1;
        throw new Error("サンドボックスの待受観測が失敗しました (HTTP 500)");
      }
      if (state.fail) throw new Error("サンドボックスの待受観測が失敗しました (HTTP 500)");
      if (scan) state.scans += 1;
      const listener = state.listeners.get(port) ?? null;
      const inodes = listener ? [...listener.inodes] : [...state.orphanInodes];
      return {
        inodes,
        addressScopes: inodes.map((_, index) => state.launchAddressScopes?.[index] ?? ("loopback" as const)),
        listener: scan && listener ? { ...listener, inodes: [...listener.inodes] } : null,
      };
    },
    // レンジ走査は待受のあるポートだけを返す (fd 走査はしない)
    scanListenerRange: async (from, to) => ({
      ports: [...state.listeners.keys()]
        .filter((port) => port >= from && port <= to)
        .sort((left, right) => left - right)
        .map((port) => ({ port, inodes: [...(state.listeners.get(port)?.inodes ?? [])] })),
    }),
  };
  return { sandbox, state, cwds, scopes };
}

/** 公開枠の待受を読み書きする (キーはポートなので、よく見る 1 本だけをここで扱う) */
export function publicListener(state: ServeSandboxState): ServeSandboxListener | null {
  return state.listeners.get(state.publicPort) ?? null;
}

export function setPublicListener(state: ServeSandboxState, listener: ServeSandboxListener | null): void {
  if (listener) state.listeners.set(state.publicPort, listener);
  else state.listeners.delete(state.publicPort);
}

/** 記録を直接置く (コンテナ再作成後や、生の bash で起動された状態の再現) */
export function putRecord(state: ServeSandboxState, record: Record<string, unknown>): void {
  state.stateFiles.set(state.publicPort, JSON.stringify(record));
}

export function readRecord(state: ServeSandboxState): Record<string, unknown> | null {
  const raw = state.stateFiles.get(state.publicPort);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** 作業ディレクトリ単位の実績ストア (AppDb の代替)。fail で 503 経路を再現する */
export function createCommandStore(rows: ServeCommandRow[] = []): {
  db: ServeCommandStore;
  rows: Map<string, ServeCommandRow>;
  state: { fail: boolean };
} {
  const map = new Map(rows.map((row) => [row.cwd, row]));
  const state = { fail: false };
  return {
    rows: map,
    state,
    db: {
      getServeCommand: (cwd) => {
        if (state.fail) throw new Error("app db unavailable");
        return map.get(cwd);
      },
      saveServeCommand: (row) => {
        if (state.fail) throw new Error("app db unavailable");
        map.set(row.cwd, row);
      },
    },
  };
}

/** 会話 id → 作業ディレクトリ / 会話名 / 所属スペースの解決 (SessionStore の代替) */
export function createSessionLookup(
  sessions: Record<string, { cwd: string; title: string; spaceId?: string }>,
): ServeSessionLookup {
  return {
    workdirOfId: (id) => sessions[id]?.cwd,
    titleOfId: (id) => sessions[id]?.title,
    spaceOfId: (id) => sessions[id]?.spaceId,
  };
}

/** 状態を切り替えられるプローブ。呼び出し回数も数える */
export function createProbe(initial: boolean): {
  probe: ServeProbe;
  calls: () => number;
  set: (value: boolean) => void;
} {
  let value = initial;
  let calls = 0;
  return {
    probe: async () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
    set: (next: boolean) => {
      value = next;
    },
  };
}
