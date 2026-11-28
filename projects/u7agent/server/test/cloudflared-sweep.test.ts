// 前の BFF が残した cloudflared の掃除 (server/src/cloudflared.ts の sweepOrphans) を、実プロセスと /proc で検証する。
// 子の代役は `node` を `tunnel` スクリプトで動かしたもの。実体が cloudflared のパスと同じで、cmdline が固定の引数の形になる。
// 実体だけが違う代役には、同じ引数の形で動く `sh` を使う。
// 記録だけを根拠に殺すと、書き換えた記録で他のプロセスを殺せてしまうため、一致しない場合に殺さないことを主に確かめる。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudflaredLauncher, type CloudflaredLauncher } from "../src/cloudflared";
import { processStartedAtMs } from "../src/proc-stat";
import { createHarness, isPending, sleep, waitFor } from "./cloudflared-harness";

// 実プロセスの素性を /proc から読むので、Linux 以外では動かさない
const LINUX_ONLY = { skip: process.platform !== "linux" };

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

interface Identity {
  pid: number;
  startedAtMs: number;
  exe: string;
  argv: string[];
}

interface StandIn {
  child: ChildProcess;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 記録に書く素性を、掃除の実装とは別に /proc から読む */
async function identityOf(pid: number): Promise<Identity> {
  const startedAtMs = await processStartedAtMs(pid);
  assert.ok(startedAtMs, "プロセスが居る");
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
  return { pid, startedAtMs, exe: await readlink(`/proc/${pid}/exe`), argv: cmdline.split("\0").slice(0, -1) };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((done) => child.once("exit", done));
  return pid;
}

interface Fixture {
  base: string;
  stateDir: string;
  launcher: CloudflaredLauncher;
  standIns: StandIn[];
  startStandIn(args?: string[], command?: string, cwd?: string): Promise<StandIn>;
  writeRecord(name: string, record: unknown): Promise<void>;
  cleanup(): Promise<void>;
}

async function createFixture(launcherOptions: { sweepTermWaitMs?: number } = {}): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "u7agent-cloudflared-sweep-")));
  const store = join(base, "store");
  const stateDir = join(store, "tunnel");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(base, "workspace"), { recursive: true });
  await writeFile(join(base, "tunnel"), "setInterval(() => {}, 1000);\n");
  await mkdir(join(base, "sh"));
  await writeFile(join(base, "sh", "tunnel"), "while :; do sleep 1; done\n");
  const standIns: StandIn[] = [];

  const fixture: Fixture = {
    base,
    stateDir,
    standIns,
    launcher: createCloudflaredLauncher({
      // 代役の実体 (node) を cloudflared として扱う。置き場の判定は書き込み先を差し替えて通す
      env: { PI_CLOUDFLARED_PATH: process.execPath },
      sessionStoreDir: store,
      rootCwd: join(base, "workspace"),
      writeRoots: [join(base, "agent-writable")],
      instancePort: 4317,
      ...launcherOptions,
    }),
    async startStandIn(args = FIXED_ARGS, command = process.execPath, cwd = base) {
      const child = spawn(command, args, { cwd, stdio: "ignore" });
      assert.ok(child.pid);
      const standIn: StandIn = {
        child,
        pid: child.pid,
        exited: new Promise((done) => child.once("exit", (code, signal) => done({ code, signal }))),
      };
      standIns.push(standIn);
      return standIn;
    },
    writeRecord: (name, record) => writeFile(join(stateDir, name), JSON.stringify(record)),
    async cleanup() {
      for (const standIn of standIns) standIn.child.kill("SIGKILL");
      await Promise.all(standIns.map((standIn) => standIn.exited));
      await rm(base, { recursive: true, force: true });
    },
  };
  return fixture;
}

const record = (owner: { pid: number; startedAtMs: number }, home: string, child: Identity | null) => ({
  version: 1,
  owner,
  home,
  child,
});

test(
  "書いた BFF が居なければ、実体・起動時刻・cmdline が記録と一致する子を殺し、記録と専用 HOME を消す",
  LINUX_ONLY,
  async () => {
    const f = await createFixture();
    try {
      const standIn = await f.startStandIn();
      await mkdir(join(f.stateDir, "home-4317-0a0a0a0a"));
      await f.writeRecord(
        "pid-4317-0a0a0a0a.json",
        record({ pid: await deadPid(), startedAtMs: 1 }, "home-4317-0a0a0a0a", await identityOf(standIn.pid)),
      );

      const report = await f.launcher.sweepOrphans();
      assert.deepEqual(report, { killed: 1, removedRecords: 1, removedHomes: 1 });
      assert.deepEqual(await standIn.exited, { code: null, signal: "SIGTERM" });
      assert.deepEqual(await readdir(f.stateDir), []);
    } finally {
      await f.cleanup();
    }
  },
);

test("SIGTERM に応えない子には、待ったあとで SIGKILL を送る", LINUX_ONLY, async () => {
  const f = await createFixture({ sweepTermWaitMs: 300 });
  try {
    // ハンドラを入れ終えた目印を待ってから掃除へ進む (入れる前の SIGTERM は既定の動作で子を止めてしまう)
    await writeFile(
      join(f.base, "tunnel"),
      'process.on("SIGTERM", () => {});\nrequire("node:fs").writeFileSync("ignoring-sigterm", "");\nsetInterval(() => {}, 1000);\n',
    );
    const standIn = await f.startStandIn();
    await waitFor(() => existsSync(join(f.base, "ignoring-sigterm")), "SIGTERM の無視");
    await f.writeRecord(
      "pid-4317-0a0a0a0a.json",
      record({ pid: await deadPid(), startedAtMs: 1 }, "home-4317-0a0a0a0a", await identityOf(standIn.pid)),
    );

    assert.equal((await f.launcher.sweepOrphans()).killed, 1);
    assert.equal((await standIn.exited).signal, "SIGKILL");
  } finally {
    await f.cleanup();
  }
});

test("書いた BFF が生きているあいだは、子も記録も専用 HOME も触らない", LINUX_ONLY, async () => {
  const f = await createFixture();
  try {
    const standIn = await f.startStandIn();
    await mkdir(join(f.stateDir, "home-4317-0a0a0a0a"));
    const owner = { pid: process.pid, startedAtMs: (await processStartedAtMs(process.pid)) ?? 0 };
    await f.writeRecord("pid-4317-0a0a0a0a.json", record(owner, "home-4317-0a0a0a0a", await identityOf(standIn.pid)));

    const report = await f.launcher.sweepOrphans();
    assert.deepEqual(report, { killed: 0, removedRecords: 0, removedHomes: 0 });
    assert.equal(await isPending(standIn.exited, 150), true);
    assert.deepEqual((await readdir(f.stateDir)).sort(), ["home-4317-0a0a0a0a", "pid-4317-0a0a0a0a.json"]);
  } finally {
    await f.cleanup();
  }
});

test(
  "pid が別のプロセスに再利用されていれば (起動時刻が違えば) 書いた BFF は居ないものとして掃除する",
  LINUX_ONLY,
  async () => {
    const f = await createFixture();
    try {
      const standIn = await f.startStandIn();
      const startedAtMs = (await processStartedAtMs(process.pid)) ?? 0;
      await f.writeRecord(
        "pid-4317-0a0a0a0a.json",
        record(
          { pid: process.pid, startedAtMs: startedAtMs + 12_345 },
          "home-4317-0a0a0a0a",
          await identityOf(standIn.pid),
        ),
      );

      assert.equal((await f.launcher.sweepOrphans()).killed, 1);
      assert.equal((await standIn.exited).signal, "SIGTERM");
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "記録が他のプロセスを指していても殺さない (実体・起動時刻・cmdline・引数の形のどれかが違えば)",
  LINUX_ONLY,
  async () => {
    const f = await createFixture();
    try {
      const ownerGone = { pid: await deadPid(), startedAtMs: 1 };
      const unrelated = await f.startStandIn(["-e", "setInterval(() => {}, 1000)"]);
      const otherExecutable = await f.startStandIn(FIXED_ARGS, "/bin/sh", join(f.base, "sh"));
      const wrongStart = await f.startStandIn();
      const wrongArgv = await f.startStandIn();
      const extraArg = await f.startStandIn([...FIXED_ARGS, "--extra"]);
      const claimedExe = await f.startStandIn(FIXED_ARGS, "/bin/sh", join(f.base, "sh"));

      const forged: Array<[string, Identity]> = [
        ["unrelated", await identityOf(unrelated.pid)],
        ["other-exe", await identityOf(otherExecutable.pid)],
        [
          "wrong-start",
          { ...(await identityOf(wrongStart.pid)), startedAtMs: (await identityOf(wrongStart.pid)).startedAtMs + 10 },
        ],
        [
          "wrong-argv",
          {
            ...(await identityOf(wrongArgv.pid)),
            argv: [process.execPath, ...FIXED_ARGS.slice(0, -1), "http://127.0.0.1:9"],
          },
        ],
        ["extra-arg", await identityOf(extraArg.pid)],
        // exe を cloudflared のパスと書いても、/proc の実体 (sh) と食い違う
        ["claimed-exe", { ...(await identityOf(claimedExe.pid)), exe: await realpath(process.execPath) }],
      ];
      for (const [index, [name, identity]] of forged.entries()) {
        await f.writeRecord(`pid-4317-0000000${index}.json`, record(ownerGone, `home-4317-0000000${index}`, identity));
        assert.ok(name);
      }

      const report = await f.launcher.sweepOrphans();
      assert.equal(report.killed, 0);
      assert.equal(report.removedRecords, 6, "一致しないときは、何も殺さず記録だけ消す");
      await sleep(150);
      for (const standIn of f.standIns) assert.equal(isAlive(standIn.pid), true);
      assert.deepEqual(await readdir(f.stateDir), []);
    } finally {
      await f.cleanup();
    }
  },
);

test("壊れた記録や不正な記録があっても落ちず、記録だけ消して置き場の外は消さない", LINUX_ONLY, async () => {
  const f = await createFixture();
  try {
    const victim = join(f.base, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "keep");
    await writeFile(join(f.stateDir, "pid-4317-0b0b0b0b.json"), "{not json");
    await f.writeRecord("pid-4317-0c0c0c0c.json", { version: 2 });
    await f.writeRecord(
      "pid-4317-0d0d0d0d.json",
      record({ pid: await deadPid(), startedAtMs: 1 }, "../../victim", null),
    );
    await writeFile(join(f.stateDir, "notes.txt"), "not ours");

    const report = await f.launcher.sweepOrphans();
    assert.equal(report.removedRecords, 3);
    assert.deepEqual(await readdir(f.stateDir), ["notes.txt"]);
    assert.equal(existsSync(join(victim, "keep.txt")), true);
  } finally {
    await f.cleanup();
  }
});

test("残った古い専用 HOME は消すが、生きている BFF の HOME と、名前の形が違うものは消さない", LINUX_ONLY, async () => {
  const f = await createFixture();
  try {
    for (const name of ["home-4317-deadbeef", "home-4317-cafecafe", "home-abc", "other-dir"]) {
      await mkdir(join(f.stateDir, name));
      await writeFile(join(f.stateDir, name, "state"), "x");
    }
    const owner = { pid: process.pid, startedAtMs: (await processStartedAtMs(process.pid)) ?? 0 };
    await f.writeRecord("pid-4317-cafecafe.json", record(owner, "home-4317-cafecafe", null));

    const report = await f.launcher.sweepOrphans();
    assert.deepEqual(report, { killed: 0, removedRecords: 0, removedHomes: 1 });
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

test("置き場がまだ無くても、掃除は何もせず終わる", LINUX_ONLY, async () => {
  const f = await createFixture();
  try {
    await rm(f.stateDir, { recursive: true });
    assert.deepEqual(await f.launcher.sweepOrphans(), { killed: 0, removedRecords: 0, removedHomes: 0 });
  } finally {
    await f.cleanup();
  }
});

test("launch は掃除が終わってから子を起こす", LINUX_ONLY, async () => {
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
