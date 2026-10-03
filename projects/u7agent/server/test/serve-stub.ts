/**
 * serve のテスト用スタブ。サンドボックスへ送る bash スクリプトを解釈し、作業領域の状態
 * (記録 / 待受 PID) を仮想的に持つ。実スクリプトの文言を変えたらここも追随させる。
 */
import type { ServeCommandRow } from "../src/app-db";
import type { SandboxExecClient } from "../src/sandbox/client";
import type { ServeCommandStore, ServeProbe, ServeSessionLookup } from "../src/serve";

export interface ServeSandboxState {
  /** 仮想の `<appdir>/serve/state.json` の中身 */
  stateFile: string | null;
  /** いま listen しているプロセス (観測スクリプトが返す値)。ancestors は自身から親をたどった PID */
  listener: { pid: number; startedAt: number; inodes: number[]; ancestors: number[] } | null;
  /** launch スクリプトが起動したと見なす PID */
  launchPid: number;
  /** launch で listen が始まるか。false で「起動したが到達しない」を再現する */
  launchListens: boolean;
  /**
   * launch と同時に listen を始める別のプロセス (遅れて listen した別の起動の再現)。
   * 設定されていると launch はこちらの listener を返す
   */
  listenerOnLaunch: { pid: number; startedAt: number; inodes: number[]; ancestors: number[] } | null;
  /** launch で listen を始めるソケットの inode */
  launchInodes: number[];
  /** listen しているが PID を特定できない状態の inode (fd 走査をしても listener 行を返さない) */
  orphanInodes: number[];
  /** launch したプロセスの起動時刻 (観測スクリプトが返す値) */
  launchStartedAt: number;
  launched: Array<{ workdir: string; command: string; log: string }>;
  /** launch へ渡した env (渡さなければ undefined)。起動時の環境変数注入の検証に使う */
  launchEnvs: (Record<string, string> | undefined)[];
  killed: number[];
  /** kill が効くか。false で「停止してもポートが空かない」状態を再現する */
  killWorks: boolean;
  /** 記録を書いた回数 (起動の成功では仮の記録と待受 PID の 2 回) */
  writes: number;
  /** fd 走査つきの観測回数 (状態表示では増えない) */
  scans: number;
  /** サンドボックス側の失敗を再現する (印を返さない) */
  fail: boolean;
}

export interface ServeSandboxStub {
  sandbox: SandboxExecClient;
  state: ServeSandboxState;
  /** execute に渡された cwd (作業領域の読み書きは root で行う) */
  cwds: string[];
}

/** スクリプトに埋め込まれた base64 を取り出す (launch は workdir → command の順に埋め込む) */
function embedded(script: string): string[] {
  return [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/g)].map((match) =>
    Buffer.from(match[1], "base64").toString("utf8"),
  );
}

export function createServeSandboxStub(): ServeSandboxStub {
  const state: ServeSandboxState = {
    stateFile: null,
    listener: null,
    launchPid: 4242,
    launchListens: true,
    listenerOnLaunch: null,
    launchInodes: [4242],
    orphanInodes: [],
    launchStartedAt: 1_700_000_000_000,
    launched: [],
    launchEnvs: [],
    killed: [],
    writes: 0,
    scans: 0,
    fail: false,
    killWorks: true,
  };
  const cwds: string[] = [];
  const sandbox: SandboxExecClient = {
    execute: async (_tool, input) => {
      cwds.push(input.cwd ?? "");
      if (state.fail) throw new Error("サンドボックスのツール実行が失敗しました (HTTP 500)");
      const { command } = (input.params ?? {}) as { command?: string };
      const script = command ?? "";
      if (script.includes("nohup bash -c")) {
        const [workdir, command] = embedded(script);
        state.launchEnvs.push(input.env);
        state.launched.push({
          workdir: workdir ?? "",
          command: command ?? "",
          log: /log="\$root\/([^"]*)"/.exec(script)?.[1] ?? "",
        });
        if (state.listenerOnLaunch) {
          state.listener = state.listenerOnLaunch;
        } else if (state.launchListens) {
          state.listener = {
            pid: state.launchPid,
            startedAt: state.launchStartedAt,
            inodes: [...state.launchInodes],
            ancestors: [state.launchPid],
          };
        }
        return { content: [{ type: "text", text: `pid\t${state.launchPid}\nserve:ok\n` }] };
      }
      if (script.includes("rm -f")) {
        state.stateFile = null;
        return { content: [{ type: "text", text: "serve:ok\n" }] };
      }
      if (script.includes("kill ")) {
        state.killed.push(Number(/kill (\d+)/.exec(script)?.[1]));
        if (state.killWorks) state.listener = null;
        return { content: [{ type: "text", text: "serve:ok\n" }] };
      }
      if (script.includes("state.json") && script.includes("base64 -d")) {
        state.stateFile = embedded(script)[0] ?? null;
        state.writes += 1;
        return { content: [{ type: "text", text: "serve:ok\n" }] };
      }
      // 観測スクリプト。fd 走査つきの観測 (SCAN = true) だけが listener / ancestors を返す
      const scan = script.includes("const SCAN = true;");
      if (scan) state.scans += 1;
      const lines: string[] = [];
      lines.push(`inodes\t${(state.listener ? state.listener.inodes : state.orphanInodes).join(" ")}`);
      if (scan && state.listener) {
        lines.push(`listener\t${state.listener.pid}\t${state.listener.startedAt}`);
        lines.push(`ancestors\t${state.listener.ancestors.join(" ")}`);
      }
      if (state.stateFile) lines.push(`record\t${state.stateFile}`);
      return { content: [{ type: "text", text: `${lines.join("\n")}\nserve:ok\n` }] };
    },
  };
  return { sandbox, state, cwds };
}

/** 記録を直接置く (コンテナ再作成後や、生の bash で起動された状態の再現) */
export function putRecord(state: ServeSandboxState, record: Record<string, unknown>): void {
  state.stateFile = JSON.stringify(record);
}

export function readRecord(state: ServeSandboxState): Record<string, unknown> | null {
  return state.stateFile ? (JSON.parse(state.stateFile) as Record<string, unknown>) : null;
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

/** 会話 id → 作業ディレクトリ / 会話名の解決 (SessionStore の代替) */
export function createSessionLookup(sessions: Record<string, { cwd: string; title: string }>): ServeSessionLookup {
  return {
    workdirOfId: (id) => sessions[id]?.cwd,
    titleOfId: (id) => sessions[id]?.title,
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
