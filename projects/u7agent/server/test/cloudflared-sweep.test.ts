// 前の BFF が残した cloudflared の掃除 (server/src/cloudflared.ts の sweepOrphans) を検証する。
// プロセスの観測とシグナルはメモリ上の表で差し替え、実プロセスは起こさない。一致しないときに殺さないことを主に見る。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCloudflaredLauncher,
  type CloudflaredLauncher,
  type CloudflaredLauncherOptions,
  type ProcessReading,
  type SignalOutcome,
} from "../src/cloudflared";
import type { ProcessRef } from "../src/pidfd";
import { createHarness, writeExecutable } from "./cloudflared-harness";

const FIXED_ARGS = [
  "tunnel",
  "--no-autoupdate",
  "--config",
  "/dev/null",
  "--metrics",
  "127.0.0.1:20241",
  "--grace-period",
  "5s",
  "--url",
  "http://127.0.0.1:8080",
];

const SELF_START = 1_700_000_000_000;
const DEAD_OWNER = { pid: 4999, startedAtMs: 1 };
const LIVE_OWNER = { pid: process.pid, startedAtMs: SELF_START };

type Present = Extract<ProcessReading, { state: "present" }>;

interface RecordedIdentity {
  pid: number;
  startedAtMs?: number;
  exe: string;
  argv: string[];
}

class ProcessTable {
  readonly table = new Map<number, ProcessReading>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  readonly denied = new Set<number>();
  readonly ignoresTerm = new Set<number>();
  readonly immortal = new Set<number>();
  /** pidfd を開けるか (開けない環境では掃除は何も送らない) */
  refsAvailable = true;
  openedRefs = 0;
  closedRefs = 0;
  /** 観測のあとに呼ぶ。並行して起動した BFF を差し込む */
  afterRead?: (pid: number) => void;
  /** シグナルのあとに呼ぶ。pid の再利用を差し込む */
  afterSignal?: (pid: number, signal: NodeJS.Signals) => void;

  readonly readProcess = async (pid: number): Promise<ProcessReading> => {
    const reading = this.table.get(pid) ?? ({ state: "gone" } as const);
    this.afterRead?.(pid);
    return reading;
  };

  readonly signalProcess = (pid: number, signal: NodeJS.Signals): SignalOutcome => {
    this.signals.push({ pid, signal });
    if (!this.table.has(pid)) return "gone";
    if (this.denied.has(pid)) return "denied";
    const survives = (signal === "SIGTERM" && this.ignoresTerm.has(pid)) || this.immortal.has(pid);
    if (!survives) this.table.delete(pid);
    this.afterSignal?.(pid, signal);
    return "sent";
  };

  /** pidfd の代役。開いた時点の実物を掴み、pid が再利用されたら別のプロセスへは届かない */
  readonly openProcessRef = async (pid: number): Promise<ProcessRef | undefined> => {
    const bound = this.table.get(pid);
    if (!this.refsAvailable || !bound || bound.state !== "present") return undefined;
    this.openedRefs += 1;
    return {
      send: (signal) => (this.table.get(pid) === bound ? this.signalProcess(pid, signal) : "gone"),
      close: () => {
        this.closedRefs += 1;
      },
    };
  };
}

interface Fixture {
  base: string;
  binary: string;
  stateDir: string;
  procs: ProcessTable;
  launcher: CloudflaredLauncher;
  /** 起動した子として実物が持つ素性 (cwd は専用 HOME)。記録に書く値の元にもなる */
  genuine(pid: number, home: string): Present;
  writeRecord(name: string, record: unknown): Promise<void>;
  makeHome(name: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function createFixture(overrides: Partial<CloudflaredLauncherOptions> = {}): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "u7agent-cloudflared-sweep-")));
  const binaryPath = join(base, "bin", "cloudflared");
  await writeExecutable(binaryPath);
  const binary = await realpath(binaryPath);
  const store = join(base, "store");
  await mkdir(store, { recursive: true });
  const stateDir = join(await realpath(store), "tunnel");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(base, "workspace"), { recursive: true });

  const procs = new ProcessTable();
  procs.table.set(process.pid, {
    state: "present",
    startedAtMs: SELF_START,
    exe: process.execPath,
    argv: [process.execPath],
    cwd: process.cwd(),
  });

  return {
    base,
    binary,
    stateDir,
    procs,
    launcher: createCloudflaredLauncher({
      env: { PI_CLOUDFLARED_PATH: binaryPath },
      sessionStoreDir: store,
      rootCwd: join(base, "workspace"),
      writeRoots: [join(base, "agent-writable")],
      instancePort: 4317,
      readProcess: procs.readProcess,
      openProcessRef: procs.openProcessRef,
      lockHeld: async () => "free",
      sweepTermWaitMs: 40,
      ...overrides,
    }),
    genuine: (pid, home) => ({
      state: "present",
      startedAtMs: 10_000 + pid,
      exe: binary,
      argv: [binary, ...FIXED_ARGS],
      cwd: join(stateDir, home),
    }),
    writeRecord: (name, record) => writeFile(join(stateDir, name), JSON.stringify(record)),
    makeHome: async (name) => {
      await mkdir(join(stateDir, name));
      await writeFile(join(stateDir, name, "state"), "x");
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

const identity = (pid: number, reading: Present): RecordedIdentity => ({
  pid,
  startedAtMs: reading.startedAtMs,
  exe: reading.exe,
  argv: reading.argv,
});

const record = (owner: { pid: number; startedAtMs: number }, home: string, child: RecordedIdentity | null) => ({
  version: 1,
  owner,
  home,
  child,
});

const HOME = "home-4317-0a0a0a0a";
const RECORD = "pid-4317-0a0a0a0a.json";

/** 書いた BFF が居ない記録と、記録どおりの子を用意する */
async function plantOrphan(f: Fixture, pid = 5001): Promise<Present> {
  const reading = f.genuine(pid, HOME);
  f.procs.table.set(pid, reading);
  await f.makeHome(HOME);
  await f.writeRecord(RECORD, record(DEAD_OWNER, HOME, identity(pid, reading)));
  return reading;
}

test("書いた BFF が居なければ、実物が記録と全部一致する子を止め、記録と専用 HOME を消す", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 1, failed: 0, removedRecords: 1, removedHomes: 1 });
    assert.deepEqual(f.procs.signals, [{ pid: 5001, signal: "SIGTERM" }]);
    assert.deepEqual(await readdir(f.stateDir), []);
  } finally {
    await f.cleanup();
  }
});

test("書いた BFF が生きているあいだは、子も記録も専用 HOME も触らない", async () => {
  const f = await createFixture();
  try {
    const reading = f.genuine(5001, HOME);
    f.procs.table.set(5001, reading);
    await f.makeHome(HOME);
    await f.writeRecord(RECORD, record(LIVE_OWNER, HOME, identity(5001, reading)));

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 });
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD]);
  } finally {
    await f.cleanup();
  }
});

test("pid が別のプロセスに再利用されていれば (起動時刻が違えば) 書いた BFF は居ないものとして掃除する", async () => {
  const f = await createFixture();
  try {
    const reading = f.genuine(5001, HOME);
    f.procs.table.set(5001, reading);
    await f.writeRecord(
      RECORD,
      record({ pid: process.pid, startedAtMs: SELF_START + 12_345 }, HOME, identity(5001, reading)),
    );

    assert.equal((await f.launcher.sweepOrphans()).killed, 1);
    assert.deepEqual(f.procs.signals, [{ pid: 5001, signal: "SIGTERM" }]);
  } finally {
    await f.cleanup();
  }
});

test("記録が他のプロセスを指していても殺さない (実物の実体・起動時刻・cmdline・作業ディレクトリ・引数の形のどれかが違えば)", async () => {
  const f = await createFixture();
  try {
    const otherHome = join(f.stateDir, "home-4317-bbbbbbbb");
    const cases: Array<{ actual?: Partial<Present>; recorded?: Partial<RecordedIdentity> }> = [
      // 無関係なプロセスを、実物どおりに書いた記録
      {
        actual: { exe: "/usr/bin/vim", argv: ["/usr/bin/vim", "a.txt"] },
        recorded: { exe: "/usr/bin/vim", argv: ["/usr/bin/vim", "a.txt"] },
      },
      // 別の実体で、引数だけが固定の形
      { actual: { exe: "/bin/sh" }, recorded: { exe: "/bin/sh" } },
      // 起動時刻が違う
      { recorded: { startedAtMs: 10_000 + 7002 + 10 } },
      // cmdline が記録と違う
      { recorded: { argv: [f.binary, ...FIXED_ARGS.slice(0, -1), "http://127.0.0.1:9"] } },
      // 引数が固定の形でない
      {
        actual: { argv: [f.binary, ...FIXED_ARGS, "--extra"] },
        recorded: { argv: [f.binary, ...FIXED_ARGS, "--extra"] },
      },
      // 記録の実体を cloudflared と偽る
      { actual: { exe: "/bin/sh" } },
      // 作業ディレクトリが、記録の専用 HOME ではない (別インスタンスの子)
      { actual: { cwd: otherHome } },
    ];
    for (const [index, { actual, recorded }] of cases.entries()) {
      const pid = 7000 + index;
      const home = `home-4317-0000000${index}`;
      f.procs.table.set(pid, { ...f.genuine(pid, home), ...actual });
      await f.writeRecord(
        `pid-4317-0000000${index}.json`,
        record(DEAD_OWNER, home, { ...identity(pid, f.genuine(pid, home)), ...recorded }),
      );
    }

    const report = await f.launcher.sweepOrphans();
    assert.equal(report.killed, 0);
    assert.equal(report.removedRecords, cases.length, "一致しないときは、何も殺さず記録だけ消す");
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual(await readdir(f.stateDir), []);
  } finally {
    await f.cleanup();
  }
});

test("起動元のロックが生きているあいだは、記録の owner が死んでいても止めない", async () => {
  const f = await createFixture({ lockHeld: async () => "held" });
  try {
    const reading = f.genuine(5001, HOME);
    f.procs.table.set(5001, reading);
    await f.makeHome(HOME);
    await f.writeRecord(RECORD, record(DEAD_OWNER, HOME, identity(5001, reading)));

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 });
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD], "起動元が居るあいだは、次の掃除に任せる");
  } finally {
    await f.cleanup();
  }
});

test("起動元のロックが外れていれば、subreaper に引き取られた孤児として止める", async () => {
  const f = await createFixture({ lockHeld: async () => "free" });
  try {
    const reading = f.genuine(5001, HOME);
    f.procs.table.set(5001, reading);
    await f.makeHome(HOME);
    await f.writeRecord(RECORD, record(DEAD_OWNER, HOME, identity(5001, reading)));

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 1, failed: 0, removedRecords: 1, removedHomes: 1 });
    assert.deepEqual(f.procs.signals, [{ pid: 5001, signal: "SIGTERM" }]);
  } finally {
    await f.cleanup();
  }
});

test("起動元のロックの状態を確かめられなければ、止めずに記録と専用 HOME を残す", async () => {
  const f = await createFixture({ lockHeld: async () => "unknown" });
  try {
    const reading = f.genuine(5001, HOME);
    f.procs.table.set(5001, reading);
    await f.makeHome(HOME);
    await f.writeRecord(RECORD, record(DEAD_OWNER, HOME, identity(5001, reading)));

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 1, removedRecords: 0, removedHomes: 0 });
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD]);
  } finally {
    await f.cleanup();
  }
});

test("記録の home がファイル名と違えば、その home を cwd の根拠にしない", async () => {
  const f = await createFixture();
  try {
    const realHome = "home-4317-11111111";
    const reading = f.genuine(5001, realHome);
    f.procs.table.set(5001, reading);
    await f.makeHome(realHome);
    // 正規の記録の名前で、別の home を指す
    await f.writeRecord("pid-4317-22222222.json", record(DEAD_OWNER, realHome, identity(5001, reading)));

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 1, removedHomes: 1 });
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual(await readdir(f.stateDir), []);
  } finally {
    await f.cleanup();
  }
});

test("pidfd を開けない環境では、記録と一致しても送らず、記録と専用 HOME を残す", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);
    f.procs.refsAvailable = false;

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 1, removedRecords: 0, removedHomes: 0 });
    assert.deepEqual(f.procs.signals, [], "数値の pid へ落とさない");
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD]);
  } finally {
    await f.cleanup();
  }
});

test("照合のあと、pidfd を開くまでに pid が再利用されたら、そのプロセスへは送らない", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);
    f.procs.afterRead = (pid) => {
      if (pid !== 5001) return;
      f.procs.afterRead = undefined;
      f.procs.table.set(pid, {
        ...f.genuine(pid, HOME),
        startedAtMs: 99_999,
        exe: "/usr/bin/bystander",
        argv: ["/usr/bin/bystander"],
      });
    };

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 1, removedHomes: 1 });
    assert.deepEqual(f.procs.signals, []);
    assert.equal(f.procs.openedRefs, 1);
    assert.equal(f.procs.closedRefs, 1, "掴んだ参照は閉じる");
  } finally {
    await f.cleanup();
  }
});

test("読めない記録は、観測不能として記録も専用 HOME も残す", async () => {
  const f = await createFixture({
    readRecordFile: async (path) => {
      if (path.endsWith(RECORD)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return readFile(path, "utf8");
    },
  });
  try {
    await plantOrphan(f);

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 });
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD]);
  } finally {
    await f.cleanup();
  }
});

test("生きている BFF の記録が指す子は、別の記録が同じ子を指しても殺さない", async () => {
  const f = await createFixture();
  try {
    const reading = f.genuine(5001, HOME);
    f.procs.table.set(5001, reading);
    await f.makeHome(HOME);
    await f.writeRecord(RECORD, record(LIVE_OWNER, HOME, identity(5001, reading)));
    // 書き換えた記録が、稼働中の BFF の子を自分の子として指す
    await f.writeRecord("pid-4317-0b0b0b0b.json", record(DEAD_OWNER, HOME, identity(5001, reading)));

    const report = await f.launcher.sweepOrphans();
    assert.equal(report.killed, 0);
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD], "稼働中の BFF の記録と専用 HOME は残る");
  } finally {
    await f.cleanup();
  }
});

test("SIGTERM に応えない子には、待ったあとで SIGKILL を送る", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);
    f.procs.ignoresTerm.add(5001);

    assert.equal((await f.launcher.sweepOrphans()).killed, 1);
    assert.deepEqual(
      f.procs.signals.map((entry) => entry.signal),
      ["SIGTERM", "SIGKILL"],
    );
  } finally {
    await f.cleanup();
  }
});

test("SIGTERM のあとに pid が別のプロセスへ再利用されたら、SIGKILL を送らない", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);
    f.procs.ignoresTerm.add(5001);
    f.procs.afterSignal = (pid) => {
      f.procs.table.set(pid, {
        ...f.genuine(pid, HOME),
        startedAtMs: 99_999,
        exe: "/usr/bin/bystander",
        argv: ["/usr/bin/bystander"],
      });
    };

    await f.launcher.sweepOrphans();
    assert.deepEqual(
      f.procs.signals.map((entry) => entry.signal),
      ["SIGTERM"],
      "別のプロセスには何も送らない",
    );
  } finally {
    await f.cleanup();
  }
});

test("止められなかった子 (kill の拒否・SIGKILL でも残る) は、記録と専用 HOME を残して failed に数える", async () => {
  const cases: Array<[string, (procs: ProcessTable) => void]> = [
    ["kill が拒否される", (procs) => procs.denied.add(5001)],
    ["SIGKILL でも残る", (procs) => procs.immortal.add(5001)],
  ];
  for (const [name, setup] of cases) {
    const f = await createFixture();
    try {
      await plantOrphan(f);
      setup(f.procs);

      assert.deepEqual(
        await f.launcher.sweepOrphans(),
        { killed: 0, failed: 1, removedRecords: 0, removedHomes: 0 },
        name,
      );
      assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD], `${name}: 次の掃除が見つけられるように残す`);
    } finally {
      await f.cleanup();
    }
  }
});

test("壊れた記録や不正な記録があっても落ちず、記録だけ消して置き場の外は消さない", async () => {
  const f = await createFixture();
  try {
    const victim = join(f.base, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "keep");
    await writeFile(join(f.stateDir, "pid-4317-0b0b0b0b.json"), "{not json");
    await f.writeRecord("pid-4317-0c0c0c0c.json", { version: 2 });
    await f.writeRecord("pid-4317-0d0d0d0d.json", record(DEAD_OWNER, "../../victim", null));
    await writeFile(join(f.stateDir, "notes.txt"), "not ours");

    const report = await f.launcher.sweepOrphans();
    assert.equal(report.removedRecords, 3);
    assert.deepEqual(await readdir(f.stateDir), ["notes.txt"]);
    assert.equal(existsSync(join(victim, "keep.txt")), true);
  } finally {
    await f.cleanup();
  }
});

test("残った古い専用 HOME は消すが、生きている BFF の HOME と、名前の形が違うものは消さない", async () => {
  const f = await createFixture();
  try {
    for (const name of ["home-4317-deadbeef", "home-4317-cafecafe", "home-abc", "other-dir"]) await f.makeHome(name);
    await f.writeRecord("pid-4317-cafecafe.json", record(LIVE_OWNER, "home-4317-cafecafe", null));

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 0, removedHomes: 1 });
    assert.deepEqual((await readdir(f.stateDir)).sort(), [
      "home-4317-cafecafe",
      "home-abc",
      "other-dir",
      "pid-4317-cafecafe.json",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("掃除の最中に、同じ置き場で別の BFF が起動して記録と専用 HOME を作っても、それは消さない", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);
    const otherHome = "home-4320-0e0e0e0e";
    let started = false;
    // 古い記録の持ち主を確かめている最中に、稼働中の別の BFF が、記録 → 専用 HOME の順に作る
    f.procs.afterRead = (pid) => {
      if (pid !== DEAD_OWNER.pid || started) return;
      started = true;
      writeFileSync(join(f.stateDir, "pid-4320-0e0e0e0e.json"), JSON.stringify(record(LIVE_OWNER, otherHome, null)));
      mkdirSync(join(f.stateDir, otherHome));
    };

    const report = await f.launcher.sweepOrphans();
    assert.equal(started, true);
    assert.equal(report.killed, 1);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [otherHome, "pid-4320-0e0e0e0e.json"]);
  } finally {
    await f.cleanup();
  }
});

test("/proc を読めない環境では、何も殺さず何も消さない", async () => {
  const f = await createFixture();
  try {
    await plantOrphan(f);
    f.procs.table.delete(process.pid);

    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 });
    assert.deepEqual(f.procs.signals, []);
    assert.deepEqual((await readdir(f.stateDir)).sort(), [HOME, RECORD]);
  } finally {
    await f.cleanup();
  }
});

test("書いている最中に止まった古い .json.tmp だけを消す", async () => {
  const f = await createFixture();
  try {
    const stale = join(f.stateDir, "pid-4317-aaaaaaaa.json.tmp");
    const fresh = join(f.stateDir, "pid-4317-bbbbbbbb.json.tmp");
    await writeFile(stale, "{");
    await writeFile(fresh, "{");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, longAgo, longAgo);

    await f.launcher.sweepOrphans();
    assert.deepEqual(await readdir(f.stateDir), ["pid-4317-bbbbbbbb.json.tmp"]);
  } finally {
    await f.cleanup();
  }
});

test("置き場がまだ無くても、掃除は何もせず終わる", async () => {
  const f = await createFixture();
  try {
    await rm(f.stateDir, { recursive: true });
    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, failed: 0, removedRecords: 0, removedHomes: 0 });
  } finally {
    await f.cleanup();
  }
});

test("launch は掃除が終わってから子を起こす", async () => {
  const h = await createHarness();
  try {
    await mkdir(h.stateDir, { recursive: true });
    const stale = join(h.stateDir, "pid-4317-0a0a0a0a.json");
    await writeFile(stale, "{broken");
    let staleGoneAtSpawn: boolean | undefined;
    h.behavior.onSpawn = () => {
      staleGoneAtSpawn = !existsSync(stale);
    };
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: "swept-first.trycloudflare.com" });
    h.metrics.readyStatus = 200;

    await h.launch().ready;
    assert.equal(staleGoneAtSpawn, true);
  } finally {
    await h.dispose();
  }
});
